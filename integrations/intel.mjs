/**
 * Intel Stream: unified event-driven data source layer.
 *
 * Three tiers:
 *  1. TG Channels (GramJS)  — true real-time push
 *  2. Twitter/X  (XActions)  — 10min poll KOLs + keyword search
 *  3. Free APIs              — low-freq supplement (1h/6h)
 *
 * All items flow through: normalize → dedup → score → route (trigger / cache / DB-only)
 */

import { createHash } from 'crypto';

export function createIntelStream({ config, db }) {
  const INTEL = config.INTEL || {};
  const _log = { info: (...a) => console.log('[Intel]', ...a), error: (...a) => console.error('[Intel]', ...a), warn: (...a) => console.warn('[Intel]', ...a) };

  // --- State ---
  let _triggerHandler = null;
  let _lastTriggerTs = 0;
  const _cache = [];            // recent high-value items (score >= 50)
  const _seenHashes = new Map(); // hash → timestamp (FIFO eviction)
  let _fearGreedCache = null;
  let _tgClient = null;
  const _intervals = [];
  let _stats = { tgConnected: false, xConnected: false, itemsIngested: 0, triggered: 0 };

  // =========================================================================
  //  IMPACT SCORING (no LLM, pure rules)
  // =========================================================================
  function _scoreItem(item) {
    if (item.score > 0) return item.score;

    let score = 35;
    const t = (item.title || '').toLowerCase();

    // FLASH keywords (+35)
    if (/hack|exploit|rugpull|crash|SEC\s|ban\b|delist|halt|emergency|liquidat/i.test(t)) score += 35;
    // PRIORITY keywords (+20)
    else if (/ETF|listing|partner|upgrade|fork|regulat|approval|whale|massive|billion/i.test(t)) score += 20;

    // Energy FLASH (+30)
    if (/OPEC.*cut|oil.*surge|crude.*crash|sanctions.*oil|pipeline.*attack/i.test(t)) score += 30;

    // Coin mentions (+10)
    if (/\bBTC\b|\bETH\b|\bSOL\b|bitcoin|ethereum/i.test(t)) score += 10;

    // Has directional signal (+10)
    if (item.signal && item.signal !== 'neutral') score += 10;

    // High-weight sources (+10)
    if (/cointelegraph|coindesk|bloomberg|reuters|whale.alert/i.test(item.source || '')) score += 10;

    // Twitter KOL boost (+15)
    if (/lookonchain|whale_alert|DeItaone|tier10k|EmberCN/i.test(item.source || '')) score += 15;

    return Math.min(score, 100);
  }

  // =========================================================================
  //  NORMALIZE — unified format from any source
  // =========================================================================
  function _normalize(raw, origin) {
    return {
      title: (raw.title || raw.headline || raw.text || raw.content || '').slice(0, 200).trim(),
      score: raw.score || raw.aiRating?.score || 0,
      signal: raw.signal || raw.aiRating?.signal || 'neutral',
      source: raw.source || origin || 'unknown',
      link: raw.link || raw.url || '',
      coins: raw.coins || [],
      origin,
      ts: Date.now(),
    };
  }

  // =========================================================================
  //  DEDUP — MD5(title_lower + source)
  // =========================================================================
  function _dedup(item) {
    const raw = (item.title || '').toLowerCase().trim() + '|' + (item.source || '');
    const hash = createHash('md5').update(raw).digest('hex');
    if (_seenHashes.has(hash)) return null;

    // FIFO eviction
    if (_seenHashes.size >= (INTEL.dedupMaxHashes || 5000)) {
      const oldest = _seenHashes.keys().next().value;
      _seenHashes.delete(oldest);
    }
    _seenHashes.set(hash, Date.now());
    item._hash = hash;
    return item;
  }

  // =========================================================================
  //  CLASSIFY
  // =========================================================================
  function _classify(item) {
    const t = (item.title || '').toLowerCase();
    if (/oil|crude|brent|wti|opec|energy|natgas|pipeline/i.test(t)) return 'energy';
    if (/listing|delist|announcement/i.test(t)) return 'listing';
    if (/fed|cpi|gdp|inflation|unemployment|treasury/i.test(t)) return 'macro';
    return 'crypto';
  }

  // =========================================================================
  //  INGEST — the core pipeline: normalize → dedup → score → route
  // =========================================================================
  function _ingest(raw, origin) {
    const item = _normalize(raw, origin);
    if (!item.title) return;

    const deduped = _dedup(item);
    if (!deduped) return; // duplicate

    deduped.score = _scoreItem(deduped);
    deduped.category = _classify(deduped);
    _stats.itemsIngested++;

    // Persist to DB
    try {
      db.insertIntel.run(
        deduped.title, deduped.source, deduped.link,
        deduped.score, deduped.signal,
        JSON.stringify(deduped.coins), deduped.category,
        deduped.origin, deduped._hash,
        deduped.score >= (INTEL.triggerThreshold || 80) ? 1 : 0
      );
    } catch { /* UNIQUE constraint = already persisted */ }

    // Route by impact
    if (deduped.score >= (INTEL.triggerThreshold || 80)) {
      // FLASH — trigger instant analysis
      const now = Date.now();
      const cooldown = INTEL.cooldownMs || 5 * 60 * 1000;
      if (_triggerHandler && now - _lastTriggerTs >= cooldown) {
        _lastTriggerTs = now;
        _stats.triggered++;
        _log.info(`FLASH [${deduped.score}] ${deduped.title.slice(0, 80)} (${deduped.origin})`);
        try { _triggerHandler(deduped); } catch (e) { _log.error('trigger_handler_error', e.message); }
      }
      _cache.unshift(deduped);
    } else if (deduped.score >= 50) {
      // PRIORITY — cache for next analyst cycle
      _cache.unshift(deduped);
    }
    // <50 — DB only

    // Cache management
    while (_cache.length > (INTEL.cacheMaxItems || 500)) _cache.pop();
    // TTL: remove items older than 2h
    const cutoff = Date.now() - 2 * 3600 * 1000;
    while (_cache.length > 0 && _cache[_cache.length - 1].ts < cutoff) _cache.pop();
  }

  // =========================================================================
  //  TG CHANNEL MONITOR (GramJS — true real-time push)
  // =========================================================================
  async function _initTelegram() {
    if (!INTEL.tg?.apiId || !INTEL.tg?.apiHash || !INTEL.tg?.session) {
      _log.warn('TG credentials missing, skipping TG channel monitor');
      return;
    }
    try {
      const { TelegramClient } = await import('telegram');
      const { StringSession } = await import('telegram/sessions/index.js');
      const { NewMessage } = await import('telegram/events/index.js');

      const session = new StringSession(INTEL.tg.session);
      _tgClient = new TelegramClient(session, INTEL.tg.apiId, INTEL.tg.apiHash, {
        connectionRetries: 5,
        autoReconnect: true,
      });

      await _tgClient.connect();
      _stats.tgConnected = true;

      // Collect all channel usernames
      const allChannels = [
        ...(INTEL.tg.channels?.crypto || []),
        ...(INTEL.tg.channels?.energy || []),
      ];

      _log.info(`TG connected, monitoring ${allChannels.length} channels`);

      // Register event handler for new messages from monitored channels
      _tgClient.addEventHandler((event) => {
        try {
          const msg = event.message;
          if (!msg?.message) return;
          const chat = msg.peerId;
          const channelName = msg?.chat?.username || chat?.channelId?.toString() || 'unknown';
          _ingest({
            title: msg.message,
            source: `tg:${channelName}`,
          }, `tg:${channelName}`);
        } catch (e) { _log.error('tg_message_handler_error', e.message); }
      }, new NewMessage({ chats: allChannels }));
    } catch (e) {
      _log.error('TG init failed:', e.message);
      _stats.tgConnected = false;
    }
  }

  // =========================================================================
  //  TWITTER/X MONITOR (XActions — 10min poll)
  // =========================================================================
  let _xModule = null;
  let _xLoadFailed = false;

  async function _getXActions() {
    if (_xLoadFailed) return null;
    if (_xModule) return _xModule;
    try {
      const mod = await import('xactions');
      _xModule = mod.default || mod;
      return _xModule;
    } catch (e) {
      _xLoadFailed = true;
      _log.warn('XActions import failed (Twitter/X disabled):', e.message);
      _stats.xConnected = false;
      return null;
    }
  }

  async function _pollXKols() {
    if (!INTEL.x?.enabled) return;
    const XActions = await _getXActions();
    if (!XActions) return;
    try {
      const x = typeof XActions === 'function' ? new XActions({ authToken: INTEL.x.authToken }) : XActions;
      const getTweets = x.getTweets || x.get_tweets;
      if (!getTweets) { _log.warn('XActions: no getTweets method'); _xLoadFailed = true; return; }
      for (const kol of (INTEL.x.kols || [])) {
        try {
          const tweets = await getTweets.call(x, kol, 3);
          if (Array.isArray(tweets)) {
            for (const t of tweets) {
              _ingest({
                title: t.text || t.content || '',
                source: `x:@${kol}`,
                link: t.url || '',
              }, 'twitter');
            }
          }
        } catch { /* individual KOL fail is not critical */ }
      }
    } catch (e) { _log.warn('X KOL poll failed:', e.message); }
  }

  async function _pollXKeywords() {
    if (!INTEL.x?.enabled) return;
    const XActions = await _getXActions();
    if (!XActions) return;
    try {
      const x = typeof XActions === 'function' ? new XActions({ authToken: INTEL.x.authToken }) : XActions;
      const search = x.searchTweets || x.search_tweets;
      if (!search) return;
      for (const kw of (INTEL.x.keywords || [])) {
        try {
          const results = await search.call(x, kw, 5);
          if (Array.isArray(results)) {
            for (const t of results) {
              _ingest({
                title: t.text || t.content || '',
                source: `x:search`,
                link: t.url || '',
              }, 'twitter');
            }
          }
        } catch { /* individual keyword fail not critical */ }
      }
    } catch (e) { _log.warn('X keyword poll failed:', e.message); }
  }

  // =========================================================================
  //  API POLLERS (low-frequency supplement)
  // =========================================================================
  async function _pollDailyNews() {
    try {
      // Fetch multiple crypto subcategories
      for (const sub of ['defi', 'bitcoin', 'altcoin', 'market']) {
        try {
          const url = `${INTEL.apis.dailyNews.url}?category=crypto&subcategory=${sub}`;
          const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
          if (!res.ok) continue;
          const data = await res.json();
          // News items
          const items = data.news?.items || [];
          for (const n of items) {
            _ingest({
              title: n.title || n.summary_zh || n.summary_en || '',
              score: n.score || 0,
              signal: n.signal || 'neutral',
              source: n.source || '6551',
              link: n.link || '',
              coins: n.coins || [],
            }, 'daily-news');
          }
          // Tweet items
          const tweets = data.tweets?.items || [];
          for (const t of tweets) {
            _ingest({
              title: t.content || '',
              source: `6551:${t.handle || t.author || ''}`,
              link: t.url || '',
            }, 'daily-news-tweets');
          }
        } catch { /* subcategory fail not critical */ }
      }
    } catch (e) { _log.warn('daily-news poll failed:', e.message); }
  }

  async function _pollBreaking() {
    try {
      const url = INTEL.apis.breaking.url;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return;
      const data = await res.json();
      const articles = data.articles || data.data || [];
      for (const a of articles) {
        _ingest({
          title: a.title || a.headline || '',
          source: a.source || 'crypto-news',
          link: a.link || a.url || '',
        }, 'breaking');
      }
    } catch (e) { _log.warn('breaking poll failed:', e.message); }
  }

  async function _pollFearGreed() {
    try {
      const url = INTEL.apis.fearGreed.url;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return;
      const data = await res.json();
      _fearGreedCache = {
        value: data.value ?? data.data?.value ?? data.fgi?.value ?? null,
        label: data.label ?? data.data?.label ?? data.fgi?.classification ?? null,
        ts: Date.now(),
      };
    } catch (e) { _log.warn('fear-greed poll failed:', e.message); }
  }

  // =========================================================================
  //  PUBLIC API
  // =========================================================================

  /** Start all data streams and pollers. */
  async function start() {
    _log.info('Starting Intel Stream...');

    // 1. TG Channels (real-time push)
    _initTelegram().catch(e => _log.error('TG start failed:', e.message));

    // 2. Twitter/X (10min poll)
    if (INTEL.x?.enabled) {
      const xInterval = INTEL.x.pollInterval || 10 * 60 * 1000;
      _pollXKols().catch(() => {});
      _intervals.push(setInterval(() => {
        _pollXKols().catch(() => {});
        _pollXKeywords().catch(() => {});
      }, xInterval));
      _stats.xConnected = true;
      _log.info(`X/Twitter polling started (${xInterval / 60000}min)`);
    }

    // 3. Free APIs (low-freq)
    // Daily news — run once now, then every 6h
    _pollDailyNews().catch(() => {});
    _intervals.push(setInterval(() => _pollDailyNews().catch(() => {}), INTEL.apis.dailyNews.interval));

    // Breaking — run once now, then every 1h
    _pollBreaking().catch(() => {});
    _intervals.push(setInterval(() => _pollBreaking().catch(() => {}), INTEL.apis.breaking.interval));

    // Fear & Greed — run once now, then every 6h
    _pollFearGreed().catch(() => {});
    _intervals.push(setInterval(() => _pollFearGreed().catch(() => {}), INTEL.apis.fearGreed.interval));

    _log.info('Intel Stream started');
  }

  /** Stop all pollers and disconnect TG. */
  function stop() {
    for (const id of _intervals) clearInterval(id);
    _intervals.length = 0;
    if (_tgClient) {
      _tgClient.disconnect().catch(() => {});
      _tgClient = null;
      _stats.tgConnected = false;
    }
    _log.info('Intel Stream stopped');
  }

  /**
   * Get recent intel items — compatible with fetchNews() format.
   * Returns: [{ title, score, signal, source, link, coins }]
   */
  function getRecentIntel(limit = 15) {
    // Purge expired items (2h TTL) before returning
    const cutoff = Date.now() - 2 * 3600 * 1000;
    while (_cache.length > 0 && _cache[_cache.length - 1].ts < cutoff) _cache.pop();

    return _cache.slice(0, limit).map(item => ({
      title: item.title,
      score: item.score,
      signal: item.signal,
      source: item.source,
      link: item.link,
      coins: item.coins,
    }));
  }

  /** Get current Fear & Greed index. */
  function getFearGreed() {
    return _fearGreedCache;
  }

  /** Register handler for high-impact events (score >= triggerThreshold). */
  function setTriggerHandler(fn) {
    _triggerHandler = fn;
  }

  /** Runtime stats. */
  function stats() {
    return { ..._stats, cacheSize: _cache.length, dedupSize: _seenHashes.size };
  }

  return { start, stop, getRecentIntel, getFearGreed, setTriggerHandler, stats };
}
