/**
 * Mandate Gate — deterministic hard rules that run BEFORE the LLM risk agent.
 *
 * 道枢坐标: (Harness, Keystone)
 * - 可信执行边界内，不依赖概率输出
 * - LLM 挂了这些规则仍然成立 (fail-closed)
 * - Mandate Gate 的 VETO 不能被 LLM 推翻
 *
 * 不 import LLM 或任何概率性模块。
 */

export function createMandateGate({ db, config, bitgetClient, bitgetWS, messageBus, log }) {
  const _log = log || { info: console.log, warn: console.warn, error: console.error };
  const { bitgetRequest } = bitgetClient;
  const _ws = bitgetWS || { isHealthy: () => false, getEquity: () => 0, getUnrealizedPnL: () => 0 };
  const postMessage = messageBus?.postMessage || (() => {});

  /**
   * Run all hard rules against current state.
   * @param {object} signal - trade signal being evaluated
   * @param {string} traceId
   * @param {{ isScout?: boolean }} [opts]
   * @returns {Promise<{ verdict: 'PASS'|'VETO', reasons: string[], rule?: string }>}
   */
  async function check(signal, traceId, opts = {}) {
    const isScout = opts.isScout || false;
    const SCALING = config.SCALING;

    // --- Rule 1: Consecutive losses → cooldown ---
    // Scout positions skip this check (smallest position, worth trying even after losses)
    if (!isScout) {
      let consecutiveLossCount = 0;
      if (SCALING?.enabled) {
        const recentGroups = db.prepare("SELECT pnl, closed_at FROM position_groups WHERE status IN ('closed', 'abandoned') ORDER BY closed_at DESC LIMIT 10").all();
        for (const g of recentGroups) { if ((g.pnl || 0) < 0) consecutiveLossCount++; else break; }
      } else {
        const recentTrades = db.prepare("SELECT pnl FROM trades WHERE status = 'closed' AND (pnl IS NOT NULL AND pnl != 0) ORDER BY closed_at DESC LIMIT 10").all();
        for (const t of recentTrades) { if (t.pnl < 0) consecutiveLossCount++; else break; }
      }
      const lossThresholdCount = SCALING?.enabled ? 5 : 3;

      if (consecutiveLossCount >= lossThresholdCount) {
        const lastLossQuery = SCALING?.enabled
          ? "SELECT closed_at FROM position_groups WHERE status IN ('closed', 'abandoned') AND pnl < 0 ORDER BY closed_at DESC LIMIT 1"
          : "SELECT closed_at FROM trades WHERE status = 'closed' AND pnl < 0 ORDER BY closed_at DESC LIMIT 1";
        const lastLoss = db.prepare(lastLossQuery).get();
        if (lastLoss?.closed_at) {
          const cooldownEnd = new Date(lastLoss.closed_at + 'Z').getTime() + 60 * 60 * 1000; // 1h
          if (Date.now() < cooldownEnd) {
            const reason = `连续${lossThresholdCount}笔亏损，冷却期至 ${new Date(cooldownEnd).toISOString().slice(11, 16)}`;
            postMessage('mandate_gate', 'executor', 'VETO', { reason }, traceId);
            return { verdict: 'VETO', reasons: [reason], rule: 'consecutive_loss_cooldown' };
          }
        }
      }
    }

    // --- Rule 2: Total exposure limit (scaling mode) ---
    if (SCALING?.enabled) {
      const activeGroups = db.prepare("SELECT total_size, symbol FROM position_groups WHERE status = 'active'").all();
      const totalExposure = activeGroups.reduce((s, g) => s + (g.total_size || 0), 0);
      if (totalExposure >= SCALING.max_exposure_eth) {
        const reason = `总敞口 ${totalExposure.toFixed(4)} 已达上限 ${SCALING.max_exposure_eth}`;
        return { verdict: 'VETO', reasons: [reason], rule: 'max_exposure' };
      }
    }

    // --- Rule 3: 24h cumulative loss > 5% (realized + unrealized) ---
    const h24 = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const recent24h = db.prepare('SELECT pnl FROM trades WHERE status = ? AND closed_at > ?').all('closed', h24);
    let loss24h = recent24h.reduce((s, t) => s + Math.min(0, t.pnl || 0), 0);

    // Include unrealized PnL (floating losses count)
    let unrealizedLoss = 0;
    if (_ws.isHealthy()) {
      unrealizedLoss = Math.min(0, _ws.getUnrealizedPnL());
    } else {
      try {
        const posData = await bitgetRequest('GET', '/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT');
        const positions = Array.isArray(posData) ? posData : (posData?.list || []);
        unrealizedLoss = positions.reduce((s, p) => s + Math.min(0, parseFloat(p.unrealizedPL || '0')), 0);
      } catch (e) { _log.warn('unrealized_pnl_fetch_failed', { module: 'mandate_gate', error: e.message }); }
    }
    loss24h += unrealizedLoss;

    // --- Rule 4: Equity fetch — fail-closed ---
    let equity = _ws.isHealthy() ? _ws.getEquity() : 0;
    if (equity <= 0) {
      try {
        const accts = await bitgetRequest('GET', '/api/v2/mix/account/accounts?productType=USDT-FUTURES').catch(() => []);
        equity = parseFloat((accts || []).find(a => a.marginCoin === 'USDT')?.accountEquity || '0');
      } catch (e) { _log.warn('equity_fetch_failed', { module: 'mandate_gate', error: e.message }); }
    }
    const lossThreshold = equity > 0 ? equity * 0.05 : 0;
    if (lossThreshold <= 0) {
      _log.warn('equity_unknown_veto', { module: 'mandate_gate' });
      return { verdict: 'VETO', reasons: ['无法获取账户权益，暂停交易'], rule: 'equity_unknown' };
    }
    if (loss24h < -lossThreshold) {
      const reason = `24小时累计亏损 ${loss24h.toFixed(2)} USDC (含浮亏)，超过安全阈值 (${lossThreshold.toFixed(2)})`;
      postMessage('mandate_gate', 'executor', 'VETO', { reason }, traceId);
      return { verdict: 'VETO', reasons: [reason], rule: '24h_loss_limit' };
    }

    // All hard rules passed
    return { verdict: 'PASS', reasons: [], checkedRules: 4 };
  }

  return { check };
}
