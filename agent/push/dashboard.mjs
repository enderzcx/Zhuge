/**
 * TG Dashboard — scheduled status posts to owner or supergroup topics.
 *
 * Posts:
 *   positions — every 5min, pinned (持仓 + PnL + 余额)
 *   observe   — every 30min (系统状态 + metrics 摘要)
 *   compound  — on compound run (AI 规则更新)
 *   pnl_chart — every 6h (PnL 曲线图片)
 *
 * If TG_DASHBOARD_CHAT is set → posts to supergroup topics.
 * Otherwise → posts to TG_CHAT_ID (owner DM).
 */

// 30 min (was 5 min). Reduced at owner's explicit request after moving the
// dashboard target to a topic-based supergroup where 5-minute cadence was
// too noisy for community members. Same cadence applies to owner-DM mode
// — the owner doesn't need a fresh snapshot every 5 minutes when they can
// query the agent directly; 30-minute ambient visibility is sufficient.
const POSITIONS_INTERVAL = 30 * 60 * 1000;
const OBSERVE_INTERVAL = 2 * 60 * 60 * 1000; // 2h
const CHART_INTERVAL = 6 * 60 * 60 * 1000;  // 6 h

export function createDashboard({ config, db, tgCall, health, metrics, log, dataSources, llm }) {
  const _log = log || { info() {}, warn() {}, error() {} };
  const chatId = config.TG_DASHBOARD_CHAT || config.TG_CHAT_ID;
  const timers = [];
  let pinnedPositionMsgId = null;

  // Pre-compiled statements (avoid re-preparing every interval)
  const stmts = {
    openTrades: db.prepare("SELECT pair, side, leverage, entry_price, amount FROM trades WHERE status = 'open'"),
    tradeStats: db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins, SUM(pnl) as total_pnl FROM trades WHERE status = 'closed' AND pnl != 0"),
    llmStats: db.prepare("SELECT COUNT(*) as cnt, AVG(value) as avg FROM metrics WHERE name = 'llm_latency_ms' AND ts > ?"),
    errorStats: db.prepare("SELECT SUM(value) as total FROM metrics WHERE name = 'error_count' AND ts > ?"),
    pnlTrades: db.prepare("SELECT pnl, closed_at FROM trades WHERE status = 'closed' AND pnl != 0 ORDER BY closed_at ASC"),
    compoundRules: db.prepare("SELECT description, action, confidence FROM compound_rules WHERE status = 'active' ORDER BY confidence DESC LIMIT 5"),
  };

  // --- LLM helpers ---

  async function _translate(text) {
    if (!llm || !text) return text;
    try {
      const result = await llm(
        [{ role: 'user', content: `翻译成简洁的中文，保留关键地名/人名/数字，不要加任何解释，直接输出翻译：\n\n${text.slice(0, 500)}` }],
        { max_tokens: 300, timeout: 15000 }
      );
      return (result.content || result || text).trim();
    } catch { return text; }
  }

  /**
   * LLM filter: only keep items that matter for trading/markets.
   * Input: array of { text } items. Returns filtered + translated array.
   */
  async function _filterForTrading(items, type = 'urgent') {
    if (!llm || items.length === 0) return items;
    try {
      const numbered = items.map((it, i) => `${i + 1}. ${(it.text || it.headline || it.title || '').slice(0, 150)}`).join('\n');
      const result = await llm(
        [{ role: 'user', content: `你是交易员的信息过滤器。以下${items.length}条${type === 'urgent' ? '快讯' : '新闻'}，只保留对金融市场/交易影响最大的（如：战争影响油价、央行政策、大宗商品供应中断、地缘风险影响避险情绪、制裁影响供应链等）。

${numbered}

规则：
- 最多选 5 条，按重要性排序（最重要的排前面）
- 同一事件的多条报道只保留最重要的一条
- 纯政治/社会新闻不选，除非直接影响市场
- 输出格式：只输出保留的编号（逗号分隔，按重要性排序），如 "3,1,5"
- 如果都不相关就输出 "none"
不要解释。` }],
        { max_tokens: 50, timeout: 10000 }
      );
      const answer = (result.content || result || '').trim();
      // Explicit "nothing relevant" → real rejection, caller can trust
      // `[]` as the final verdict and safely mark those items as seen.
      if (answer === 'none' || answer.toLowerCase().includes('none')) return [];
      const digitMatches = [...answer.matchAll(/\d+/g)];
      // Malformed LLM reply (no digits at all): treat as pass-through so a
      // transient formatting glitch doesn't permanently suppress a batch
      // when the caller commits on `[]`. This preserves the existing
      // fail-permissive behavior of the `catch` branch below.
      if (digitMatches.length === 0) return items;
      const keepIds = digitMatches.map(m => parseInt(m[0])).filter(n => n > 0 && n <= items.length);
      // Reply had digits but none in range: also treat as malformed /
      // pass-through for the same reason.
      if (keepIds.length === 0) return items;
      return items.filter((_, i) => keepIds.includes(i + 1));
    } catch { return items; } // on error, pass through all
  }

  // --- Topic thread IDs (set if using supergroup with topics) ---
  const topics = {
    positions: config.TG_TOPIC_POSITIONS || null,
    observe: config.TG_TOPIC_OBSERVE || null,
    compound: config.TG_TOPIC_COMPOUND || null,
    chart: config.TG_TOPIC_CHART || null,
    news: config.TG_TOPIC_NEWS || null,
    system: config.TG_TOPIC_OBSERVE || null, // dream/system alerts share observe topic
  };

  async function _send(text, topicKey) {
    const body = { chat_id: chatId, text: text.slice(0, 4000) };
    if (topics[topicKey]) body.message_thread_id = topics[topicKey];
    try {
      return await tgCall('sendMessage', body);
    } catch (err) {
      _log.error('dashboard_send_failed', { module: 'dashboard', topic: topicKey, error: err.message });
      return null;
    }
  }

  async function _pin(messageId) {
    try {
      await tgCall('pinChatMessage', {
        chat_id: chatId,
        message_id: messageId,
        disable_notification: true,
      });
    } catch {}
  }

  async function _edit(messageId, text) {
    try {
      await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: text.slice(0, 4000),
      });
    } catch {
      // Message deleted or too old, send new one
      return null;
    }
    return messageId;
  }

  // === Positions Post ===

  /**
   * Rollout / migration note (accepted residual risk):
   *
   * This function no longer pins the positions snapshot — pinning was
   * unhelpful in forum topics with community members, and the 30-minute
   * cadence doesn't need a pin to be findable.
   *
   * On deployments upgrading from the previous pin-and-edit behavior, the
   * old pinned message will remain pinned until an operator manually
   * unpins it once. We intentionally do NOT auto-unpin on first post
   * because the only APIs that target the legacy pin without its
   * message_id (`unpinAllForumTopicMessages`, `unpinChatMessage` with no
   * id) are too broad and would also clear any unrelated message the
   * owner pinned manually in the same chat/topic — a strictly worse
   * regression than the stale-pin cosmetic issue itself.
   *
   * If this migration path ever becomes important in the future, the
   * correct fix is to persist the pinned-message id to a state file when
   * we pin it, and read it back on startup to issue a targeted unpin.
   * Not worth the extra persistence layer today.
   */
  async function postPositions() {
    try {
      const openTrades = stmts.openTrades.all();
      const stats = stmts.tradeStats.get();

      const winRate = stats.total > 0 ? ((stats.wins / stats.total) * 100).toFixed(1) : '0';

      let text = '📊 Positions & PnL\n\n';
      if (openTrades.length === 0) {
        text += '当前无持仓\n';
      } else {
        text += openTrades.map(t =>
          `${t.pair} ${t.side} ${t.leverage}x | entry: ${t.entry_price}`
        ).join('\n') + '\n';
      }
      text += `\n📈 总PnL: $${(stats.total_pnl || 0).toFixed(2)} | ${stats.total || 0}笔 | 胜率: ${winRate}%`;
      text += `\n🕐 ${new Date().toISOString().slice(11, 16)} UTC`;

      // Edit the most recently-sent positions message to keep the topic tidy
      // (single updating message instead of a flood). No pin — pinning a
      // topic message is noisy for community members and the 30-min cadence
      // makes pin unnecessary.
      if (pinnedPositionMsgId) {
        const ok = await _edit(pinnedPositionMsgId, text);
        if (!ok) pinnedPositionMsgId = null;
      }
      if (!pinnedPositionMsgId) {
        const res = await _send(text, 'positions');
        if (res?.result?.message_id) {
          pinnedPositionMsgId = res.result.message_id;
        }
      }
    } catch (err) {
      _log.error('post_positions_failed', { module: 'dashboard', error: err.message });
    }
  }

  // === Observe Post ===

  async function postObserve() {
    try {
      const snap = health.snapshot();

      // Recent metrics summary
      const now = Date.now();
      const hour = now - 60 * 60 * 1000;

      let llmCalls = 0, llmAvgMs = 0, errorCount = 0;
      try {
        const llmS = stmts.llmStats.get(hour);
        llmCalls = llmS?.cnt || 0;
        llmAvgMs = Math.round(llmS?.avg || 0);
        errorCount = stmts.errorStats.get(hour)?.total || 0;
      } catch {}

      const text = [
        '🖥 System Status',
        '',
        `MEM: ${snap.mem_pct}% | Heap: ${snap.heap_mb}MB | RSS: ${snap.rss_mb}MB`,
        `MEM: ${snap.mem_free_mb}MB free / ${snap.mem_total_mb}MB total`,
        `Uptime: ${snap.uptime_h}h | CPUs: ${snap.cpus}`,
        '',
        `🤖 Agent (last 1h)`,
        `LLM: ${llmCalls} calls, avg ${llmAvgMs}ms`,
        `Errors: ${errorCount}`,
        '',
        `🕐 ${new Date().toISOString().slice(11, 16)} UTC`,
      ].join('\n');

      await _send(text, 'observe');
    } catch (err) {
      _log.error('post_observe_failed', { module: 'dashboard', error: err.message });
    }
  }

  // === Compound Post ===

  async function postCompound(result) {
    if (!result) return;
    const lines = [
      '🧠 Compound Knowledge Update',
      '',
      `Reviewed: ${result.trades} trades`,
      `Rules: +${result.generated} new | ~${result.updated} updated | -${result.deprecated} deprecated`,
    ];

    // Strategies
    if (result.strategiesCreated || result.strategiesUpdated || result.strategiesRetired) {
      lines.push(`Strategies: +${result.strategiesCreated || 0} | ~${result.strategiesUpdated || 0} | -${result.strategiesRetired || 0}`);
    }

    // Knowledge feedback
    if (result.knowledgeBoosted || result.knowledgeDemoted) {
      lines.push(`Knowledge: +${result.knowledgeBoosted || 0} boosted | -${result.knowledgeDemoted || 0} demoted`);
      if (result.knowledgeFeedback?.length > 0) {
        for (const fb of result.knowledgeFeedback.slice(0, 5)) {
          const icon = fb.action === 'boost' ? '↑' : '↓';
          lines.push(`  ${icon} ${fb.title} (${fb.delta > 0 ? '+' : ''}${fb.delta}): ${(fb.reason || '').slice(0, 60)}`);
        }
      }
    }

    lines.push('');
    // Show current active rules
    try {
      const rules = stmts.compoundRules.all();
      rules.forEach(r => {
        const icon = r.action === 'avoid' ? '⚠' : r.action === 'prefer' ? '✓' : '~';
        lines.push(`${icon} ${r.description} (${(r.confidence * 100).toFixed(0)}%)`);
      });
    } catch { lines.push('(no rules yet)'); }

    await _send(lines.join('\n'), 'compound');
  }

  // === PnL Chart (quickchart.io) ===

  async function postPnLChart() {
    try {
      const trades = stmts.pnlTrades.all();
      if (trades.length < 3) return;

      // Cumulative PnL
      let cumPnl = 0;
      const labels = [];
      const data = [];
      trades.forEach(t => {
        cumPnl += t.pnl;
        labels.push(t.closed_at?.slice(5, 10) || '');
        data.push(Number(cumPnl.toFixed(2)));
      });

      const chartConfig = {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'Cumulative PnL ($)',
            data,
            borderColor: cumPnl >= 0 ? '#33C78C' : '#F24D59',
            backgroundColor: 'rgba(74,143,255,0.1)',
            fill: true,
            tension: 0.3,
          }],
        },
        options: {
          plugins: { legend: { display: false } },
          scales: {
            y: { grid: { color: '#262633' }, ticks: { color: '#8C8C99' } },
            x: { grid: { display: false }, ticks: { color: '#8C8C99', maxTicksLimit: 8 } },
          },
        },
      };

      const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&backgroundColor=%23121219&width=600&height=300`;

      await tgCall('sendPhoto', {
        chat_id: chatId,
        photo: chartUrl,
        caption: `📈 PnL Curve | Total: $${cumPnl.toFixed(2)} | ${trades.length} trades`,
        ...(topics.chart ? { message_thread_id: topics.chart } : topics.positions ? { message_thread_id: topics.positions } : {}),
      });
    } catch (err) {
      _log.error('post_chart_failed', { module: 'dashboard', error: err.message });
    }
  }

  // === TG Urgent — Real-time geopolitical alerts ===

  const URGENT_INTERVAL = 2 * 60 * 1000; // check every 2min
  const seenUrgentHashes = new Set();

  async function checkTgUrgent() {
    if (!dataSources) return;
    try {
      const crucix = await dataSources.fetchCrucix();
      const urgent = crucix?.tg?.urgent || [];
      if (urgent.length === 0) return;

      // Dedup (unchanged from pre-v2; immediate commit so in-batch dupes
      // within a single fetch are suppressed).
      const newItems = [];
      for (const item of urgent) {
        const hash = (item.channel || '') + ':' + (item.text || '').slice(0, 50);
        if (seenUrgentHashes.has(hash)) continue;
        seenUrgentHashes.add(hash);
        newItems.push(item);
      }
      if (seenUrgentHashes.size > 200) {
        const arr = [...seenUrgentHashes];
        arr.slice(0, 100).forEach(h => seenUrgentHashes.delete(h));
      }
      if (newItems.length === 0) return;

      // LLM filter: only keep market-relevant items
      const filtered = await _filterForTrading(newItems, 'urgent');
      if (filtered.length === 0) return;

      // Batch: translate and send as one message (max 5)
      const translatedItems = [];
      for (const item of filtered.slice(0, 5)) {
        const translated = await _translate((item.text || '').slice(0, 300));
        translatedItems.push(`⚡ [${item.channel || '?'}]\n${translated}`);
      }

      await _send(translatedItems.join('\n\n'), 'news');
    } catch (err) {
      _log.error('tg_urgent_check_failed', { module: 'dashboard', error: err.message });
    }
  }

  // === News Digest — top headlines with URLs ===

  const NEWS_DIGEST_INTERVAL = 60 * 60 * 1000; // every 1h
  // Digest-specific dedup cache, independent of urgent. Prevents the
  // hourly digest from re-posting the same top headline every cycle
  // while still letting urgent dedup run at its own cadence + cap.
  const seenDigestUrls = new Set();
  const SEEN_DIGEST_CAP = 300;
  const SEEN_DIGEST_TRIM_TO = 150;

  function _commitDigestUrls(urls) {
    for (const u of urls) seenDigestUrls.add(u);
    if (seenDigestUrls.size > SEEN_DIGEST_CAP) {
      const victims = [...seenDigestUrls].slice(0, seenDigestUrls.size - SEEN_DIGEST_TRIM_TO);
      victims.forEach(u => seenDigestUrls.delete(u));
    }
  }

  async function postNewsDigest() {
    if (!dataSources) return;
    try {
      const crucix = await dataSources.fetchCrucix();
      const feed = crucix?.newsFeed || [];
      if (feed.length === 0) return;

      // Require url + headline; dedup against seenDigestUrls BEFORE the
      // 15-item LLM cap so fresh stories beyond the top of the feed still
      // get a chance when the top is stable. Do not commit urls to the
      // seen set until after _send() succeeds, so a transient API failure
      // leaves the batch retry-eligible next hour. This is the primary
      // fix for the "ugly repeated headlines" the user reported — the
      // pre-v2 digest had no dedup at all and re-posted top-5 every run.
      const withUrl = feed.filter(n => n.url && (n.headline || n.title));
      if (withUrl.length === 0) return;

      const PENDING_CAP = 15;
      const pending = [];
      for (const n of withUrl) {
        if (seenDigestUrls.has(n.url)) continue;
        pending.push(n);
        if (pending.length >= PENDING_CAP) break;
      }
      if (pending.length === 0) return;

      // LLM filter: only keep market-relevant news. Pass originals (not
      // clones) so `_filterForTrading`'s `item.text || item.headline ||
      // item.title` fallback picks up the headline without losing object
      // identity — which lets us map filter output back to pending urls.
      //
      // Passthrough detection: when the LLM is unavailable, malformed, or
      // otherwise returns the input array unchanged, `_filterForTrading`
      // returns the SAME array reference. We check for that below to
      // suppress dedup commit in passthrough mode — otherwise the digest
      // would walk through the feed backlog instead of anchoring to the
      // current top-5 headlines (hour 1 marks 1-5 seen, hour 2 sends 6-10,
      // etc). Under passthrough we fall back to pre-v2 behavior: re-send
      // the top items every hour. That repeats headlines when LLM is down,
      // which is strictly no worse than the pre-v2 baseline.
      const relevant = await _filterForTrading(pending, 'news');
      const filterPassthrough = relevant === pending;
      if (relevant.length === 0) {
        // LLM said "none" explicitly (malformed replies now pass-through
        // in _filterForTrading, so `[]` is a real rejection). Remember
        // pending urls so we don't re-ask next hour.
        _commitDigestUrls(pending.map(p => p.url));
        return;
      }
      const top = relevant.slice(0, 5);
      const approvedSet = new Set(relevant);

      // Translate each headline individually for reliability
      const lines = ['📰 新闻摘要', ''];
      const topUrls = [];
      for (const n of top) {
        const headline = n.headline || n.title || '';
        const translated = await _translate(headline);
        const region = n.region ? ` [${n.region}]` : '';
        lines.push(`📄 ${translated}${region}`);
        lines.push(`   ${n.source || ''} | ${n.url}`);
        if (n.url) topUrls.push(n.url);
      }
      lines.push(`\n🕐 ${new Date().toISOString().slice(11, 16)} UTC`);

      const result = await _send(lines.join('\n'), 'news');
      // Commit dedup state only when ALL of the following are true:
      //  - TG Bot API returned ok:true (not just HTTP 200 with ok:false,
      //    which happens on validation errors like a stale topic id)
      //  - The LLM filter actually discriminated (not passthrough mode)
      //
      // Under passthrough we intentionally fall back to pre-v2 "resend
      // current top every hour" semantics rather than draining the feed.
      if (result?.ok && !filterPassthrough) {
        // Commit only (a) items we actually sent and (b) items the LLM
        // explicitly rejected. LLM-approved items beyond the top-5 stay
        // uncommitted so a ranking near-miss can be retried next hour.
        const rejectedUrls = pending
          .filter(p => !approvedSet.has(p))
          .map(p => p.url);
        _commitDigestUrls([...topUrls, ...rejectedUrls]);
      }
    } catch (err) {
      _log.error('news_digest_failed', { module: 'dashboard', error: err.message });
    }
  }

  // === Lifecycle ===

  function start() {
    // Delay first posts slightly to avoid startup flood
    setTimeout(postPositions, 10000);
    setTimeout(postObserve, 15000);
    setTimeout(postPnLChart, 20000);
    setTimeout(checkTgUrgent, 5000);  // urgent check starts fast
    setTimeout(postNewsDigest, 30000);

    timers.push(setInterval(postPositions, POSITIONS_INTERVAL));
    timers.push(setInterval(postObserve, OBSERVE_INTERVAL));
    timers.push(setInterval(postPnLChart, CHART_INTERVAL));
    timers.push(setInterval(checkTgUrgent, URGENT_INTERVAL));
    timers.push(setInterval(postNewsDigest, NEWS_DIGEST_INTERVAL));

    _log.info('dashboard_started', { module: 'dashboard', chatId });
  }

  function stop() {
    timers.forEach(t => clearInterval(t));
    timers.length = 0;
  }

  async function postDream(result) {
    if (!result || (result.merged === 0 && result.deleted === 0 && result.created === 0)) return;
    const lines = [
      '💤 Dream Worker (Memory Consolidation)',
      '',
      `Reviewed: ${result.notes} notes`,
      `Merged: ${result.merged} | Deleted: ${result.deleted} | Created: ${result.created}`,
      result.summary || '',
    ];
    await _send(lines.join('\n'), 'system');
  }

  return { start, stop, postPositions, postObserve, postCompound, postDream, postPnLChart, checkTgUrgent, postNewsDigest };
}
