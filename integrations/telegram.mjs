/**
 * Telegram alerting: trade alerts, agent health, heartbeat checks.
 */

export function createTelegram({ db, config, agentMetrics, cache }) {
  const TG_BOT_TOKEN = config.TG_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
  const TG_CHAT_ID = config.TG_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '';

  async function sendTelegramAlert(text) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try {
      await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) {
      console.error('[Alert] Telegram send failed:', e.message);
    }
  }

  const alertCooldowns = {}; // { 'consecutive_loss': timestamp }
  function alertCooldown(key, intervalMs = 60 * 60 * 1000) {
    const now = Date.now();
    if (alertCooldowns[key] && now - alertCooldowns[key] < intervalMs) return true;
    alertCooldowns[key] = now;
    return false;
  }

  function checkAlerts() {
    // 1. Consecutive losses (3+)
    const recentTrades = db.prepare('SELECT pnl FROM trades WHERE status = ? ORDER BY closed_at DESC LIMIT 5').all('closed');
    const consecutiveLosses = recentTrades.filter((t, i) => i < 3 && t.pnl <= 0).length;
    if (consecutiveLosses >= 3 && !alertCooldown('consecutive_loss', 3 * 60 * 60 * 1000)) {
      const totalLoss = recentTrades.slice(0, 3).reduce((s, t) => s + t.pnl, 0);
      sendTelegramAlert(`⚠️ <b>RIFI Alert: 连续亏损</b>\n连续 ${consecutiveLosses} 笔亏损，累计 ${totalLoss.toFixed(2)} USDC\n风控已触发1小时冷却期`);
    }

    // 2. Agent errors (error rate > 30%)
    for (const [name, m] of Object.entries(agentMetrics)) {
      if (m.calls >= 5 && m.errors / m.calls > 0.3 && !alertCooldown(`agent_error_${name}`, 6 * 60 * 60 * 1000)) {
        sendTelegramAlert(`⚠️ <b>RIFI Alert: ${name} Agent 异常</b>\n错误率 ${((m.errors / m.calls) * 100).toFixed(0)}% (${m.errors}/${m.calls})\n请检查 LLM 服务状态`);
      }
    }

    // 3. Agent heartbeat (no analysis in 30min)
    const lastAnalysis = cache.crypto.lastUpdate;
    if (lastAnalysis) {
      const silentMs = Date.now() - new Date(lastAnalysis).getTime();
      if (silentMs > 30 * 60 * 1000 && !alertCooldown('heartbeat', 60 * 60 * 1000)) {
        sendTelegramAlert(`⚠️ <b>RIFI Alert: 心跳异常</b>\n上次分析: ${lastAnalysis}\n已超过 ${Math.round(silentMs / 60000)} 分钟无新分析`);
      }
    }

    // 4. Large single loss (check latest closed trade)
    if (recentTrades.length > 0 && recentTrades[0].pnl < -10 && !alertCooldown('large_loss', 60 * 60 * 1000)) {
      sendTelegramAlert(`🚨 <b>RIFI Alert: 大额亏损</b>\n最近一笔亏损 ${recentTrades[0].pnl.toFixed(2)} USDC\n请确认风控参数`);
    }
  }

  return { sendTelegramAlert, checkAlerts };
}
