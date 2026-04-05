/**
 * Smart Push Engine — decides what to push to the owner via TG.
 *
 * Push levels:
 *   FLASH — market-moving events (VIX spike, BTC -5%+, geopolitical)
 *   TRADE — position opened/closed/stopped
 *   ERROR — agent down, API failures
 *   PATROL — 3h summary (handled by pipeline, not here)
 *
 * Dedup: same event won't push twice within DEDUP_WINDOW.
 * Context: each push stores full analysis chain for follow-up queries.
 */

import { createHash } from 'crypto';

const DEDUP_WINDOW = 30 * 60 * 1000; // 30 min
const MAX_CONTEXT_ITEMS = 20;        // max stored push contexts

export function createPushEngine({ db, config, tgSend, tgCall, log, metrics }) {
  const _log = log || { info() {}, warn() {}, error() {} };
  const _m = metrics || { record() {} };

  const recentPushKeys = new Map(); // key → timestamp (dedup)
  const pushContexts = new Map();   // push_id → full context (for follow-up)

  // --- Dedup ---

  function _dedupKey(level, content) {
    const hash = createHash('md5').update(`${level}:${content}`).digest('hex').slice(0, 12);
    return `${level}_${hash}`;
  }

  function _isDuplicate(key) {
    const last = recentPushKeys.get(key);
    if (last && (Date.now() - last) < DEDUP_WINDOW) return true;
    recentPushKeys.set(key, Date.now());
    // Prune old keys
    if (recentPushKeys.size > 100) {
      const cutoff = Date.now() - DEDUP_WINDOW;
      for (const [k, ts] of recentPushKeys) {
        if (ts < cutoff) recentPushKeys.delete(k);
      }
    }
    return false;
  }

  // --- Push ---

  /**
   * Push a FLASH event (analyst detected push_worthy).
   */
  async function pushFlash({ analysis, news, traceId }) {
    const reason = analysis.push_reason || analysis.briefing || '';
    const key = _dedupKey('FLASH', reason.slice(0, 100));
    if (_isDuplicate(key)) return null;

    // Build message
    const alerts = (analysis.alerts || []).filter(a => a.level === 'FLASH' || a.level === 'PRIORITY');
    const alertLines = alerts.slice(0, 4).map(a => {
      const src = a.source ? ` (${a.source})` : '';
      return `• ${a.signal}${src}`;
    });

    // News with URLs — only items that have actual URLs and titles
    const newsWithUrls = (news || [])
      .filter(n => (n.title || n.headline) && (n.url || n.link))
      .slice(0, 3)
      .map(n => {
        const icon = n.signal === 'long' ? '📈' : n.signal === 'short' ? '📉' : '📰';
        const title = (n.title || n.headline || '').slice(0, 80);
        const url = n.url || n.link || '';
        return `${icon} ${title}\n   ${url}`;
      });

    const text = [
      `🚨 FLASH`,
      '',
      reason,
      '',
      alertLines.length ? alertLines.join('\n') : null,
      newsWithUrls.length ? '\n' + newsWithUrls.join('\n') : null,
      '',
      `Risk:${analysis.macro_risk_score} Sentiment:${analysis.crypto_sentiment || analysis.stock_sentiment || '?'} Bias:${analysis.technical_bias}`,
      `Conf:${analysis.confidence} Action:${analysis.recommended_action}`,
    ].filter(v => v !== null).join('\n');

    return _send('FLASH', text, { analysis, news, traceId });
  }

  /**
   * Push a TRADE event (position opened/closed).
   */
  async function pushTrade({ action, symbol, side, leverage, price, pnl, traceId }) {
    const key = _dedupKey('TRADE', `${action}:${symbol}:${side}`);
    if (_isDuplicate(key)) return null;

    const icon = action === 'open' ? '📊' : pnl >= 0 ? '💰' : '📉';
    const actionText = action === 'open' ? 'OPEN' : 'CLOSE';
    const pnlText = pnl !== undefined ? ` | PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT` : '';

    const text = `${icon} ${actionText} ${symbol} ${side} ${leverage || 10}x @ ${price}${pnlText}`;

    return _send('TRADE', text, { action, symbol, side, leverage, price, pnl, traceId });
  }

  /**
   * Push an ERROR event.
   */
  async function pushError({ source, message, count }) {
    const key = _dedupKey('ERROR', source);
    if (_isDuplicate(key)) return null;

    const text = `⚠️ ERROR: ${source}\n${message}${count ? ` (${count}次)` : ''}`;
    return _send('ERROR', text, { source, message, count });
  }

  /**
   * Core send: format, persist, and send to TG.
   */
  async function _send(level, text, context) {
    const pushId = `push_${Date.now()}_${level.toLowerCase()}`;

    // Persist to DB
    try {
      db.insertPush.run(
        pushId, level, text,
        context.news?.[0]?.url || '',
        JSON.stringify(context.analysis || {}),
        JSON.stringify(context.news || []),
        context.analysis?.push_reason || '',
        context.traceId || '',
        new Date().toISOString(),
      );
    } catch (err) {
      _log.error('push_persist_failed', { module: 'push', error: err.message });
    }

    // Store context for follow-up
    pushContexts.set(pushId, { level, text, context, pushedAt: new Date().toISOString() });
    if (pushContexts.size > MAX_CONTEXT_ITEMS) {
      const oldest = [...pushContexts.keys()][0];
      pushContexts.delete(oldest);
    }

    // Send to TG — route to appropriate topic
    try {
      const dashChat = config.TG_DASHBOARD_CHAT;
      const topicMap = { FLASH: config.TG_TOPIC_NEWS, TRADE: config.TG_TOPIC_POSITIONS, ERROR: config.TG_TOPIC_OBSERVE };
      const threadId = dashChat ? topicMap[level] : null;

      if (dashChat && threadId && tgCall) {
        await tgCall('sendMessage', {
          chat_id: dashChat,
          message_thread_id: Number(threadId),
          text: text.slice(0, 4000),
        });
      } else {
        await tgSend(text);
      }
      _m.record('push_sent', 1, { level });
      _log.info('push_sent', { module: 'push', level, pushId });
    } catch (err) {
      _log.error('push_send_failed', { module: 'push', level, error: err.message });
      // Fallback to DM
      try { await tgSend(text); } catch {}
    }

    return pushId;
  }

  // --- Follow-up context ---

  /**
   * Get recent push context for follow-up queries.
   * Agent uses this when user asks "详细说说" or "为什么推送这个".
   */
  function getRecentContext(limit = 5) {
    return [...pushContexts.values()].slice(-limit);
  }

  /**
   * Get context for a specific push.
   */
  function getContextById(pushId) {
    return pushContexts.get(pushId) || null;
  }

  return { pushFlash, pushTrade, pushError, getRecentContext, getContextById };
}
