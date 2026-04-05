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

const POSITIONS_INTERVAL = 5 * 60 * 1000;  // 5 min
const OBSERVE_INTERVAL = 30 * 60 * 1000;    // 30 min
const CHART_INTERVAL = 6 * 60 * 60 * 1000;  // 6 h

export function createDashboard({ config, db, tgCall, health, metrics, log }) {
  const _log = log || { info() {}, warn() {}, error() {} };
  const chatId = config.TG_DASHBOARD_CHAT || config.TG_CHAT_ID;
  const timers = [];
  let pinnedPositionMsgId = null;

  // --- Topic thread IDs (set if using supergroup with topics) ---
  const topics = {
    positions: config.TG_TOPIC_POSITIONS || null,
    observe: config.TG_TOPIC_OBSERVE || null,
    compound: config.TG_TOPIC_COMPOUND || null,
    chart: config.TG_TOPIC_CHART || null,
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

  async function postPositions() {
    try {
      // Fetch positions from Bitget via existing API
      const { execSync } = await import('child_process');

      // Get positions data from DB
      const openTrades = db.prepare(
        "SELECT pair, side, leverage, entry_price, amount FROM trades WHERE status = 'open'"
      ).all();

      // Get balance from recent metrics
      const heapMb = db.prepare(
        "SELECT value FROM metrics WHERE name = 'system_rss_mb' ORDER BY ts DESC LIMIT 1"
      ).get();

      // Get PnL stats
      const stats = db.prepare(`
        SELECT COUNT(*) as total,
          SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
          SUM(pnl) as total_pnl
        FROM trades WHERE status = 'closed' AND pnl != 0
      `).get();

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

      // Edit pinned message or send new
      if (pinnedPositionMsgId) {
        const ok = await _edit(pinnedPositionMsgId, text);
        if (!ok) pinnedPositionMsgId = null;
      }
      if (!pinnedPositionMsgId) {
        const res = await _send(text, 'positions');
        if (res?.result?.message_id) {
          pinnedPositionMsgId = res.result.message_id;
          await _pin(pinnedPositionMsgId);
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
        const llmStats = db.prepare(
          "SELECT COUNT(*) as cnt, AVG(value) as avg FROM metrics WHERE name = 'llm_latency_ms' AND ts > ?"
        ).get(hour);
        llmCalls = llmStats?.cnt || 0;
        llmAvgMs = Math.round(llmStats?.avg || 0);

        const errors = db.prepare(
          "SELECT SUM(value) as total FROM metrics WHERE name = 'error_count' AND ts > ?"
        ).get(hour);
        errorCount = errors?.total || 0;
      } catch {}

      const text = [
        '🖥 System Status',
        '',
        `CPU: ${snap.mem_pct}% MEM | Heap: ${snap.heap_mb}MB | RSS: ${snap.rss_mb}MB`,
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
    const text = [
      '🧠 Compound Knowledge Update',
      '',
      `Reviewed: ${result.trades} trades`,
      `New rules: ${result.generated} | Updated: ${result.updated} | Deprecated: ${result.deprecated}`,
      '',
      // Show current active rules
      ...(() => {
        try {
          const rules = db.prepare(
            "SELECT description, action, confidence FROM compound_rules WHERE status = 'active' ORDER BY confidence DESC LIMIT 5"
          ).all();
          return rules.map(r => {
            const icon = r.action === 'avoid' ? '⚠' : r.action === 'prefer' ? '✓' : '~';
            return `${icon} ${r.description} (${(r.confidence * 100).toFixed(0)}%)`;
          });
        } catch { return ['(no rules yet)']; }
      })(),
    ].join('\n');

    await _send(text, 'compound');
  }

  // === PnL Chart (quickchart.io) ===

  async function postPnLChart() {
    try {
      const trades = db.prepare(`
        SELECT pnl, closed_at FROM trades
        WHERE status = 'closed' AND pnl != 0
        ORDER BY closed_at ASC
      `).all();
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

  // === Lifecycle ===

  function start() {
    // Delay first posts slightly to avoid startup flood
    setTimeout(postPositions, 10000);
    setTimeout(postObserve, 15000);
    setTimeout(postPnLChart, 20000);

    timers.push(setInterval(postPositions, POSITIONS_INTERVAL));
    timers.push(setInterval(postObserve, OBSERVE_INTERVAL));
    timers.push(setInterval(postPnLChart, CHART_INTERVAL));

    _log.info('dashboard_started', { module: 'dashboard', chatId });
  }

  function stop() {
    timers.forEach(t => clearInterval(t));
    timers.length = 0;
  }

  return { start, stop, postPositions, postObserve, postCompound, postPnLChart };
}
