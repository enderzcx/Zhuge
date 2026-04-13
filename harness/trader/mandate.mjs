/**
 * Trader Harness — Mandate constraints + async context builder.
 *
 * Translates the 4 hard rules from agents/mandate-gate.mjs into
 * kernel mandate DSL constraints. The context builder pre-fetches
 * all runtime data (DB queries, WS reads, REST fallbacks) so the
 * kernel mandate gate can evaluate synchronously.
 *
 * This file lives in harness/trader/ — it knows about Bitget, trades,
 * positions. The kernel mandate gate does NOT.
 */

/**
 * The 4 trader mandate constraints in kernel DSL format.
 * Mirrors agents/mandate-gate.mjs rules 1-4 exactly.
 */
export const TRADER_CONSTRAINTS = [
  {
    id: 'consecutive_loss_cooldown',
    when: { action: 'open_trade' },
    require: 'is_scout == true || consecutive_losses < loss_threshold || cooldown_expired == true',
    veto_message: '连续{consecutive_losses}笔亏损，冷却期未满',
  },
  {
    id: 'max_exposure',
    when: { action: 'open_trade' },
    require: 'scaling_enabled == false || total_exposure < max_exposure_eth',
    veto_message: '总敞口 {total_exposure} 已达上限 {max_exposure_eth}',
  },
  // equity_unknown MUST come before 24h_loss_limit because
  // loss_threshold_abs is derived from equity (equity * 0.05).
  // If equity=0, loss_threshold_abs=0 and rule 3 would false-veto.
  {
    id: 'equity_unknown',
    when: { action: 'open_trade' },
    require: 'equity > 0',
    veto_message: '无法获取账户权益，暂停交易',
  },
  {
    id: '24h_loss_limit',
    when: { action: 'open_trade' },
    require: 'loss_24h_abs < loss_threshold_abs',
    veto_message: '24h累计亏损 {loss_24h_abs} USDC (含浮亏)，超过安全阈值 {loss_threshold_abs}',
  },
];

/**
 * Load trader constraints into the kernel mandate gate.
 * @param {import('../../kernel/mandate/gate.mjs').MandateGate} gate
 */
export function loadTraderMandate(gate) {
  gate.load('trader', TRADER_CONSTRAINTS);
}

/**
 * Build the flat context object for kernel mandate evaluation.
 *
 * This is the async bridge between the kernel's synchronous expression
 * evaluator and the trader's runtime data (DB, WebSocket, REST API).
 *
 * Logic is copied verbatim from agents/mandate-gate.mjs:25-106.
 *
 * @param {{
 *   db: object,
 *   config: object,
 *   bitgetClient: { bitgetRequest: Function },
 *   bitgetWS: { isHealthy: Function, getEquity: Function, getUnrealizedPnL: Function },
 *   isScout?: boolean,
 *   log?: object
 * }} deps
 * @returns {Promise<object>} flat context for mandate gate evaluation
 */
export async function buildMandateContext({ db, config, bitgetClient, bitgetWS, isScout = false, log }) {
  const _log = log || { warn() {} };
  const { bitgetRequest } = bitgetClient;
  const _ws = bitgetWS || { isHealthy: () => false, getEquity: () => 0, getUnrealizedPnL: () => 0 };
  const SCALING = config.SCALING;

  // --- Rule 1 context: Consecutive losses ---
  let consecutiveLossCount = 0;
  if (SCALING?.enabled) {
    const recentGroups = db.prepare("SELECT pnl, closed_at FROM position_groups WHERE status IN ('closed', 'abandoned') ORDER BY closed_at DESC LIMIT 10").all();
    for (const g of recentGroups) { if ((g.pnl || 0) < 0) consecutiveLossCount++; else break; }
  } else {
    const recentTrades = db.prepare("SELECT pnl FROM trades WHERE status = 'closed' AND (pnl IS NOT NULL AND pnl != 0) ORDER BY closed_at DESC LIMIT 10").all();
    for (const t of recentTrades) { if (t.pnl < 0) consecutiveLossCount++; else break; }
  }
  const lossThresholdCount = SCALING?.enabled ? 5 : 3;

  // Cooldown check
  let cooldownExpired = true;
  if (consecutiveLossCount >= lossThresholdCount) {
    const lastLossQuery = SCALING?.enabled
      ? "SELECT closed_at FROM position_groups WHERE status IN ('closed', 'abandoned') AND pnl < 0 ORDER BY closed_at DESC LIMIT 1"
      : "SELECT closed_at FROM trades WHERE status = 'closed' AND pnl < 0 ORDER BY closed_at DESC LIMIT 1";
    const lastLoss = db.prepare(lastLossQuery).get();
    if (lastLoss?.closed_at) {
      const cooldownEnd = new Date(lastLoss.closed_at + 'Z').getTime() + 60 * 60 * 1000;
      cooldownExpired = Date.now() >= cooldownEnd;
    }
  }

  // --- Rule 2 context: Total exposure ---
  let totalExposure = 0;
  if (SCALING?.enabled) {
    const activeGroups = db.prepare("SELECT total_size FROM position_groups WHERE status = 'active'").all();
    totalExposure = activeGroups.reduce((s, g) => s + (g.total_size || 0), 0);
  }

  // --- Rule 3 context: 24h cumulative loss ---
  const h24 = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recent24h = db.prepare('SELECT pnl FROM trades WHERE status = ? AND closed_at > ?').all('closed', h24);
  let loss24h = recent24h.reduce((s, t) => s + Math.min(0, t.pnl || 0), 0);

  let unrealizedLoss = 0;
  if (_ws.isHealthy()) {
    unrealizedLoss = Math.min(0, _ws.getUnrealizedPnL());
  } else {
    try {
      const posData = await bitgetRequest('GET', '/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT');
      const positions = Array.isArray(posData) ? posData : (posData?.list || []);
      unrealizedLoss = positions.reduce((s, p) => s + Math.min(0, parseFloat(p.unrealizedPL || '0')), 0);
    } catch (e) { _log.warn('unrealized_pnl_fetch_failed', { module: 'mandate_context', error: e.message }); }
  }
  loss24h += unrealizedLoss;

  // --- Rule 4 context: Equity ---
  let equity = _ws.isHealthy() ? _ws.getEquity() : 0;
  if (equity <= 0) {
    try {
      const accts = await bitgetRequest('GET', '/api/v2/mix/account/accounts?productType=USDT-FUTURES').catch(() => []);
      equity = parseFloat((accts || []).find(a => a.marginCoin === 'USDT')?.accountEquity || '0');
    } catch (e) { _log.warn('equity_fetch_failed', { module: 'mandate_context', error: e.message }); }
  }
  const lossThresholdAbs = equity > 0 ? equity * 0.05 : 0;

  return {
    // Rule 1
    is_scout: isScout,
    consecutive_losses: consecutiveLossCount,
    loss_threshold: lossThresholdCount,
    cooldown_expired: cooldownExpired,
    // Rule 2
    scaling_enabled: !!SCALING?.enabled,
    total_exposure: totalExposure,
    max_exposure_eth: SCALING?.max_exposure_eth || Infinity,
    // Rule 3
    loss_24h_abs: Math.abs(loss24h),
    loss_threshold_abs: lossThresholdAbs,
    // Rule 4
    equity,
  };
}
