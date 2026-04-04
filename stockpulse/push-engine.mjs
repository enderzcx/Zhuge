/**
 * StockPulse Push Engine
 * Detects events from data sources, matches to user watchlists, and dispatches pushes.
 */

// ── Event types ──────────────────────────────────────────────────────────────
const EVENT = {
  PRICE_SPIKE:    'PRICE_SPIKE',     // ticker move > threshold
  VIX_SPIKE:      'VIX_SPIKE',       // VIX daily change > 15%
  NEWS_SIGNAL:    'NEWS_SIGNAL',     // OpenNews score > 85 or < 15
  GEO_ALERT:      'GEO_ALERT',      // ACLED/chokepoints new event
  MACRO_EVENT:    'MACRO_EVENT',     // FRED data update (CPI, rate decision)
  EARNINGS:       'EARNINGS',        // earnings reminder / post-release
  SECTOR_MOVE:    'SECTOR_MOVE',     // related sector anomaly
  DAILY_BRIEF:    'DAILY_BRIEF',     // scheduled morning brief
};

// ── Priority ─────────────────────────────────────────────────────────────────
const PRIORITY = { P0: 0, P1: 1, P2: 2, P3: 3 };

// ── Dedup window (ms) ────────────────────────────────────────────────────────
const DEDUP_WINDOW = 30 * 60 * 1000; // 30 min

// ── Daily push limits ────────────────────────────────────────────────────────
const TIER_LIMITS = {
  free:  { maxPush: 5,  maxWatch: 10, maxChat: 3  },
  pro:   { maxPush: -1, maxWatch: 50, maxChat: 20 },
  'pro+': { maxPush: -1, maxWatch: -1, maxChat: -1 },
};

export function createPushEngine({ db, config }) {
  // Prepared statements
  const stmts = {
    getUsers:       db.db.prepare('SELECT * FROM sp_users'),
    getUser:        db.db.prepare('SELECT * FROM sp_users WHERE telegram_id = ?'),
    upsertUser:     db.db.prepare('INSERT INTO sp_users (telegram_id, username) VALUES (?, ?) ON CONFLICT(telegram_id) DO UPDATE SET username = excluded.username'),
    addWatch:       db.db.prepare('INSERT OR IGNORE INTO sp_watchlist (telegram_id, symbol, name) VALUES (?, ?, ?)'),
    removeWatch:    db.db.prepare('DELETE FROM sp_watchlist WHERE telegram_id = ? AND symbol = ?'),
    getUserWatchlist: db.db.prepare('SELECT symbol, name FROM sp_watchlist WHERE telegram_id = ? ORDER BY added_at'),
    getAllWatchedSymbols: db.db.prepare('SELECT DISTINCT symbol FROM sp_watchlist'),
    getUsersWatchingSymbol: db.db.prepare('SELECT telegram_id FROM sp_watchlist WHERE symbol = ?'),
    logPush:        db.db.prepare('INSERT INTO sp_push_log (telegram_id, event_type, event_key, priority, symbol, message) VALUES (?, ?, ?, ?, ?, ?)'),
    recentPush:     db.db.prepare('SELECT id FROM sp_push_log WHERE event_key = ? AND pushed_at > datetime(?, \'-30 minutes\')'),
    todayPushCount: db.db.prepare('SELECT COUNT(*) as cnt FROM sp_push_log WHERE telegram_id = ? AND pushed_at > datetime(\'now\', \'start of day\')'),
  };

  // ── State ────────────────────────────────────────────────────────────────
  let lastCrucixSnapshot = null;  // previous Crucix data for change detection
  let lastVIX = null;

  // ── User management ──────────────────────────────────────────────────────

  function registerUser(telegramId, username) {
    stmts.upsertUser.run(telegramId, username || null);
  }

  function addToWatchlist(telegramId, symbol, name) {
    const user = stmts.getUser.get(telegramId);
    if (!user) return { ok: false, error: 'user_not_found' };
    const tier = TIER_LIMITS[user.tier] || TIER_LIMITS.free;
    if (tier.maxWatch > 0) {
      const current = stmts.getUserWatchlist.all(telegramId);
      if (current.length >= tier.maxWatch) return { ok: false, error: 'watchlist_full', limit: tier.maxWatch };
    }
    stmts.addWatch.run(telegramId, symbol.toUpperCase(), name || symbol.toUpperCase());
    return { ok: true };
  }

  function removeFromWatchlist(telegramId, symbol) {
    stmts.removeWatch.run(telegramId, symbol.toUpperCase());
    return { ok: true };
  }

  function getWatchlist(telegramId) {
    return stmts.getUserWatchlist.all(telegramId);
  }

  function getAllWatchedSymbols() {
    return stmts.getAllWatchedSymbols.all().map(r => r.symbol);
  }

  // ── Dedup ────────────────────────────────────────────────────────────────

  function isDuplicate(eventKey) {
    const now = new Date().toISOString();
    const row = stmts.recentPush.get(eventKey, now);
    return !!row;
  }

  // ── Push limit check ────────────────────────────────────────────────────

  function canPush(telegramId) {
    const user = stmts.getUser.get(telegramId);
    const tier = TIER_LIMITS[user?.tier] || TIER_LIMITS.free;
    if (tier.maxPush < 0) return true; // unlimited
    const { cnt } = stmts.todayPushCount.get(telegramId);
    return cnt < tier.maxPush;
  }

  // ── Event detection ──────────────────────────────────────────────────────

  /**
   * Scan Crucix + news data and return detected events.
   * @param {object} crucix - Full Crucix data
   * @param {Array} news - OpenNews items
   * @returns {Array<{type, priority, symbol?, eventKey, data}>}
   */
  function detectEvents(crucix, news) {
    const events = [];

    if (!crucix) return events;

    const m = crucix.markets || {};

    // Helper: build flat quotes lookup from Crucix arrays
    const quotes = {};
    for (const arr of [m.indexes, m.rates, m.commodities, m.crypto]) {
      if (Array.isArray(arr)) {
        for (const q of arr) { if (q?.symbol) quotes[q.symbol] = q; }
      }
    }

    // ── P0: VIX spike ────────────────────────────────────────────────────
    const currentVIX = m.vix?.value ?? (typeof m.vix === 'number' ? m.vix : null);
    if (currentVIX && lastVIX) {
      const vixChange = Math.abs(currentVIX - lastVIX) / lastVIX;
      if (vixChange > 0.15) {
        events.push({
          type: EVENT.VIX_SPIKE,
          priority: 'P0',
          symbol: 'VIX',
          eventKey: `vix_spike_${Math.floor(Date.now() / DEDUP_WINDOW)}`,
          data: { current: currentVIX, previous: lastVIX, changePct: +(vixChange * 100).toFixed(1) },
        });
      }
    }
    lastVIX = currentVIX;

    // ── P0: Index / ticker price spikes ──────────────────────────────────
    for (const [sym, q] of Object.entries(quotes)) {
      if (!q || q.error || !q.changePct) continue;
      const absPct = Math.abs(q.changePct);
      if (absPct >= 3) {
        events.push({
          type: EVENT.PRICE_SPIKE,
          priority: absPct >= 5 ? 'P0' : 'P1',
          symbol: sym,
          eventKey: `spike_${sym}_${Math.floor(Date.now() / DEDUP_WINDOW)}`,
          data: { price: q.price, changePct: q.changePct, name: q.name, marketState: q.marketState || '' },
        });
      }
    }

    // ── P0: Strong news signals (consolidated: pick the most extreme one per cycle) ──
    if (news?.length) {
      const strongNews = news.filter(n => {
        const score = n.score || n.aiRating?.score || 50;
        return score > 85 || score < 15;
      });

      if (strongNews.length > 0) {
        // Sort by extremity (furthest from 50), pick the top one
        strongNews.sort((a, b) => {
          const sa = a.score || a.aiRating?.score || 50;
          const sb = b.score || b.aiRating?.score || 50;
          return Math.abs(50 - sb) - Math.abs(50 - sa);
        });

        const top = strongNews[0];
        const topScore = top.score || top.aiRating?.score || 0;
        // Use time-window key so same type doesn't repeat within 30min
        const key = `news_signal_${Math.floor(Date.now() / DEDUP_WINDOW)}`;
        events.push({
          type: EVENT.NEWS_SIGNAL,
          priority: 'P0',
          symbol: null,
          eventKey: key,
          data: {
            title: top.title,
            score: topScore,
            signal: top.signal,
            source: top.source,
            link: top.link,
            totalStrong: strongNews.length, // how many strong signals this cycle
          },
        });
      }
    }

    // ── P0: Geopolitical alerts ──────────────────────────────────────────
    const acled = crucix.acled;
    const prevAcled = lastCrucixSnapshot?.acled;
    if (acled && prevAcled) {
      const newEvents = (acled.totalEvents || 0) - (prevAcled.totalEvents || 0);
      if (newEvents > 10) {
        events.push({
          type: EVENT.GEO_ALERT,
          priority: 'P0',
          symbol: null,
          eventKey: `geo_acled_${Math.floor(Date.now() / DEDUP_WINDOW)}`,
          data: { newEvents, totalEvents: acled.totalEvents, fatalities: acled.totalFatalities },
        });
      }
    }

    // ── P1: FRED macro data changes ──────────────────────────────────────
    if (crucix.fred && lastCrucixSnapshot?.fred) {
      const fredChanged = JSON.stringify(crucix.fred) !== JSON.stringify(lastCrucixSnapshot.fred);
      if (fredChanged) {
        events.push({
          type: EVENT.MACRO_EVENT,
          priority: 'P1',
          symbol: null,
          eventKey: `fred_update_${new Date().toISOString().split('T')[0]}`,
          data: crucix.fred,
        });
      }
    }

    // ── P1: Chokepoint status changes ────────────────────────────────────
    if (crucix.chokepoints && lastCrucixSnapshot?.chokepoints) {
      const cpChanged = JSON.stringify(crucix.chokepoints) !== JSON.stringify(lastCrucixSnapshot.chokepoints);
      if (cpChanged) {
        events.push({
          type: EVENT.GEO_ALERT,
          priority: 'P1',
          symbol: null,
          eventKey: `chokepoint_${Math.floor(Date.now() / DEDUP_WINDOW)}`,
          data: crucix.chokepoints,
        });
      }
    }

    // ── P2: Sector-level moves (multi-index divergence) ──────────────────
    const spyChg = quotes.SPY?.changePct || 0;
    const qqqChg = quotes.QQQ?.changePct || 0;
    const diaChg = quotes.DIA?.changePct || 0;
    const divergence = Math.max(Math.abs(spyChg - qqqChg), Math.abs(spyChg - diaChg));
    if (divergence > 2) {
      events.push({
        type: EVENT.SECTOR_MOVE,
        priority: 'P2',
        symbol: null,
        eventKey: `sector_div_${Math.floor(Date.now() / DEDUP_WINDOW)}`,
        data: { spy: spyChg, qqq: qqqChg, dia: diaChg, divergence: +divergence.toFixed(2) },
      });
    }

    // ── P2: Bond/equity cross-signal ─────────────────────────────────────
    const tltChg = quotes.TLT?.changePct || 0;
    if (currentVIX && Math.abs(tltChg) > 1 && currentVIX > 25) {
      events.push({
        type: EVENT.MACRO_EVENT,
        priority: 'P2',
        symbol: null,
        eventKey: `bond_risk_${Math.floor(Date.now() / DEDUP_WINDOW)}`,
        data: { vix: currentVIX, tltChange: tltChg, signal: tltChg > 0 ? 'flight-to-safety' : 'risk-on-despite-vix' },
      });
    }

    // Save snapshot for next diff
    lastCrucixSnapshot = crucix;

    return events;
  }

  // ── Match events to users ────────────────────────────────────────────────

  /**
   * For each event, find which users should receive it.
   * Returns array of { telegramId, event } pairs.
   */
  function matchEventsToUsers(events) {
    const dispatches = [];

    for (const event of events) {
      // Dedup check
      if (isDuplicate(event.eventKey)) continue;

      if (event.symbol) {
        // Ticker-specific: only push to users watching this symbol
        const watchers = stmts.getUsersWatchingSymbol.all(event.symbol);
        for (const w of watchers) {
          if (canPush(w.telegram_id)) {
            dispatches.push({ telegramId: w.telegram_id, event });
          }
        }
      } else {
        // Global event (VIX, geo, macro): push to all users
        const users = stmts.getUsers.all();
        for (const u of users) {
          if (canPush(u.telegram_id)) {
            dispatches.push({ telegramId: u.telegram_id, event });
          }
        }
      }
    }

    // Sort by priority (P0 first)
    dispatches.sort((a, b) => PRIORITY[a.event.priority] - PRIORITY[b.event.priority]);

    return dispatches;
  }

  // ── Push message formatting (template-based, no LLM) ─────────────────

  function formatPushMessage(event) {
    const { type, data, symbol } = event;
    const lines = [];

    switch (type) {
      case EVENT.PRICE_SPIKE: {
        const pct = Math.abs(data.changePct);
        const dir = data.changePct > 0;
        const state = data.marketState === 'PRE' ? '盘前' : data.marketState === 'POST' ? '盘后' : '';
        const name = data.name || symbol;
        if (dir) {
          lines.push(`${name} ${state}拉了${pct}%，现在$${data.price}。${pct > 5 ? '动静不小，看看什么在驱动。' : '留意一下后续。'}`);
        } else {
          lines.push(`${name} ${state}跌了${pct}%，现在$${data.price}。${pct > 5 ? '跌幅不小，注意风险。' : '先观察，别急。'}`);
        }
        lines.push(`回复"详细"看完整分析`);
        break;
      }
      case EVENT.VIX_SPIKE: {
        const v = data.current;
        const pct = Math.abs(data.changePct);
        if (v > 30) {
          lines.push(`市场在恐慌。VIX飙到${v}（涨了${pct}%），已经进入恐慌区间。大波动随时可能来，不是加仓的时候。`);
        } else if (v > 25) {
          lines.push(`市场开始紧张了。VIX到了${v}（变化${pct}%），波动在加大。控制好仓位，别满仓扛。`);
        } else {
          lines.push(`VIX动了一下到${v}（变化${pct}%），暂时不用太紧张，但留个心眼。`);
        }
        lines.push(`回复"风险"看完整地缘仪表盘`);
        break;
      }
      case EVENT.NEWS_SIGNAL: {
        const title = data.title || '(未获取标题)';
        lines.push(title);
        if (data.source) lines.push(`来源: ${data.source}`);
        if (data.link) lines.push(data.link);
        if (data.totalStrong > 1) lines.push(`还有${data.totalStrong - 1}条相关的`);
        lines.push(`回复"详细"让AI帮你解读`);
        break;
      }
      case EVENT.GEO_ALERT: {
        if (data.newEvents) {
          lines.push(`地缘局势升温。新增${data.newEvents}起冲突事件，全球累计${data.totalEvents}起、${data.fatalities}人伤亡。冲突越多，油价和避险情绪压力越大。`);
        } else {
          lines.push(`航运通道状态有变化，关注霍尔木兹海峡和红海航线。通道一旦受阻，油价和运费会直接反映。`);
        }
        lines.push(`回复"风险"看完整地缘仪表盘`);
        break;
      }
      case EVENT.MACRO_EVENT: {
        if (data.signal === 'bearish' || data.signal === 'short' || data.signal === 'flight-to-safety') {
          lines.push(`宏观面偏空。VIX ${data.vix || '?'}，美债TLT变化${data.tltChange > 0 ? '+' : ''}${data.tltChange || '?'}%。资金在往防御方向跑，成长股承压。`);
        } else if (data.signal === 'bullish' || data.signal === 'long' || data.signal === 'risk-on-despite-vix') {
          lines.push(`宏观面偏多。风险偏好在恢复，适合关注前期超跌的票。VIX ${data.vix || '?'}。`);
        } else {
          lines.push(`宏观数据有更新（可能涉及利率/CPI/就业），暂时方向不明，观望为主。`);
        }
        lines.push(`回复"宏观"看完整分析`);
        break;
      }
      case EVENT.SECTOR_MOVE: {
        const spy = Number(data.spy?.toFixed?.(2) ?? data.spy), qqq = Number(data.qqq?.toFixed?.(2) ?? data.qqq), dia = Number(data.dia?.toFixed?.(2) ?? data.dia);
        const qqqWorse = Math.abs(qqq) > Math.abs(spy) * 1.5;
        if (qqqWorse && qqq < 0) {
          lines.push(`科技股在挨打。QQQ跌了${Math.abs(qqq)}%但大盘只动了${Math.abs(spy)}%，资金在从科技往外撤。重仓科技的注意了。`);
        } else if (qqqWorse && qqq > 0) {
          lines.push(`科技股在领涨。QQQ涨${qqq}%远超大盘的${spy}%，市场风险偏好回来了。`);
        } else {
          lines.push(`板块在分化。SPY ${spy > 0 ? '+' : ''}${spy}%，QQQ ${qqq > 0 ? '+' : ''}${qqq}%，DIA ${dia > 0 ? '+' : ''}${dia}%。看看资金在往哪跑。`);
        }
        lines.push(`回复"详细"看板块分析`);
        break;
      }
      default:
        lines.push(`有个信号值得关注：${JSON.stringify(data).slice(0, 200)}`);
    }

    lines.push('');
    lines.push('⚠️ 仅供参考，不构成投资建议');

    return lines.join('\n');
  }

  // ── Log push ─────────────────────────────────────────────────────────────

  function logPush(telegramId, event, message) {
    stmts.logPush.run(
      telegramId,
      event.type,
      event.eventKey,
      event.priority,
      event.symbol || null,
      message
    );
  }

  // ── P2 batch buffer (flush every 60 min, not every cycle) ─────────────
  const p2Buffer = [];
  let lastP2Flush = Date.now();
  const P2_FLUSH_INTERVAL = 60 * 60 * 1000; // 1 hour

  function bufferP2Event(event) {
    p2Buffer.push(event);
  }

  function shouldFlushP2() {
    return Date.now() - lastP2Flush >= P2_FLUSH_INTERVAL;
  }

  function flushP2Buffer() {
    lastP2Flush = Date.now();
    return p2Buffer.splice(0);
  }

  // ── Main scan cycle ──────────────────────────────────────────────────────

  /**
   * Run one push engine cycle:
   * 1. Detect events from latest data
   * 2. Match to user watchlists
   * 3. Format messages
   * 4. Return dispatches (caller handles actual Telegram send)
   *
   * @param {object} crucix - Crucix data
   * @param {Array} news - OpenNews items
   * @param {object} [aiAnalyst] - Optional AI analyst for LLM enrichment
   * @param {object} [marketContext] - Compacted Crucix for LLM context
   */
  async function scan(crucix, news, aiAnalyst, marketContext) {
    const events = detectEvents(crucix, news);
    if (!events.length) return [];

    // Split by priority: P0-P1 go immediately, P2 buffered for batch
    const immediate = [];
    for (const event of events) {
      if (event.priority === 'P2') {
        bufferP2Event(event);
      } else {
        immediate.push(event);
      }
    }

    // Flush P2 buffer only if 60min have passed (hourly batch)
    const p2Events = shouldFlushP2() ? flushP2Buffer() : [];
    if (p2Events.length && aiAnalyst) {
      // Batch analyze P2 events in one LLM call
      const analyses = await aiAnalyst.batchAnalyze(p2Events, marketContext);
      for (let i = 0; i < p2Events.length; i++) {
        if (analyses[i]) p2Events[i]._llmAnalysis = analyses[i];
        immediate.push(p2Events[i]);
      }
    } else {
      immediate.push(...p2Events);
    }

    const dispatches = matchEventsToUsers(immediate);

    // For complex events, try LLM enrichment (shared: same event analyzed once)
    const llmCache = new Map();
    const results = [];

    for (const d of dispatches) {
      let message;

      if (aiAnalyst && !d.event._llmAnalysis && needsLLM(d.event)) {
        // Check LLM cache (same event shared across users)
        if (!llmCache.has(d.event.eventKey)) {
          const analysis = await aiAnalyst.analyzeEvent(d.event, marketContext);
          llmCache.set(d.event.eventKey, analysis);
        }
        const llmResult = llmCache.get(d.event.eventKey);
        message = llmResult || formatPushMessage(d.event);
      } else if (d.event._llmAnalysis) {
        // Use batch analysis result
        message = d.event._llmAnalysis;
      } else {
        message = formatPushMessage(d.event);
      }

      // Always append disclaimer
      if (!message.includes('仅供参考')) {
        message += '\n\n⚠️ 仅供参考，不构成投资建议';
      }

      logPush(d.telegramId, d.event, message);
      results.push({ telegramId: d.telegramId, message, event: d.event });
    }

    return results;
  }

  function needsLLM(event) {
    if (event.type === 'PRICE_SPIKE' && Math.abs(event.data?.changePct || 0) < 5) return false;
    return ['VIX_SPIKE', 'NEWS_SIGNAL', 'GEO_ALERT', 'MACRO_EVENT', 'SECTOR_MOVE'].includes(event.type);
  }

  return {
    scan,
    detectEvents,
    matchEventsToUsers,
    formatPushMessage,
    // User management
    registerUser,
    addToWatchlist,
    removeFromWatchlist,
    getWatchlist,
    getAllWatchedSymbols,
    // Constants
    EVENT,
    TIER_LIMITS,
  };
}
