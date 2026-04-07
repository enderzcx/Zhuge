/**
 * Risk agent: hard rules + LLM-based soft evaluation.
 */

export function createRiskAgent({ db, config, bitgetClient, bitgetWS, agentRunner, messageBus, log }) {
  const _log = log || { info: console.log, warn: console.warn, error: console.error };
  const { bitgetRequest } = bitgetClient;
  const _ws = bitgetWS || { isHealthy: () => false, getEquity: () => 0, getUnrealizedPnL: () => 0 };
  const { runAgent } = agentRunner;
  const { postMessage } = messageBus;
  const { insertDecision } = db;

  const RISK_SYSTEM_PROMPT = `You are the RIFI Risk Agent. Your sole job is to review trade signals and decide PASS or VETO.

You have tools to check the current portfolio state and trade history. Use them before deciding.

Hard rules (automatic VETO, non-negotiable):
- 24h cumulative loss > 5% of portfolio → VETO
- 3 consecutive losing trades → VETO (1h cooldown needed)
- Account balance too low to execute → VETO

Soft rules (use judgment):
- Analyst confidence < 60 → lean toward VETO
- Same direction position already open → warn, lean toward VETO unless strong signal
- Signal conflicts with recent trade direction in last 1h → extra caution

Your workflow:
1. Call get_trade_stats to check recent performance
2. Call get_recent_decisions to see what happened recently
3. Evaluate the signal against rules
4. Call submit_verdict with your decision. Do NOT output raw JSON text.`;

  const RISK_TOOLS = [
    {
      type: 'function',
      function: {
        name: 'get_trade_stats',
        description: 'Get trading performance stats: win rate, PnL, drawdown, open positions, recent closed trades',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_recent_decisions',
        description: 'Get recent agent decisions from the decision ledger (last 20)',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'submit_verdict',
        description: 'Submit your final PASS or VETO decision. You MUST call this tool as your last step.',
        parameters: {
          type: 'object',
          properties: {
            verdict: { type: 'string', enum: ['PASS', 'VETO'] },
            reason: { type: 'string', description: 'One-line Chinese explanation' },
            risk_flags: { type: 'array', items: { type: 'string' }, description: 'Warning flags even if PASS' },
          },
          required: ['verdict', 'reason'],
        },
      },
    },
  ];

  const RISK_EXECUTORS = {
    submit_verdict: async (args) => JSON.stringify({ status: 'submitted' }),
    get_trade_stats: async () => {
      // Filter out pnl=0 trades (unfilled limit orders) for accurate stats
      const closed = db.prepare("SELECT * FROM trades WHERE status = 'closed' AND (pnl IS NOT NULL AND pnl != 0) ORDER BY closed_at DESC LIMIT 20").all();
      const open = db.prepare("SELECT * FROM trades WHERE status = 'open' ORDER BY opened_at DESC").all();
      const wins = closed.filter(t => t.pnl > 0);
      const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
      // 24h loss check
      const h24 = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const recent24h = closed.filter(t => t.closed_at && t.closed_at > h24);
      const loss24h = recent24h.reduce((s, t) => s + Math.min(0, t.pnl || 0), 0);
      // Consecutive losses (only count actual losses, not unfilled orders)
      let consecutiveLosses = 0;
      for (const t of closed) {
        if (t.pnl < 0) consecutiveLosses++;
        else break;
      }
      return JSON.stringify({
        total_closed: closed.length, wins: wins.length,
        win_rate: closed.length > 0 ? ((wins.length / closed.length) * 100).toFixed(1) + '%' : 'N/A',
        total_pnl: totalPnl.toFixed(4),
        loss_24h: loss24h.toFixed(4),
        consecutive_losses: consecutiveLosses,
        open_positions: open.map(t => ({ pair: t.pair, side: t.side, amount: t.amount, entry_price: t.entry_price })),
        recent_3: closed.slice(0, 3).map(t => ({ pnl: t.pnl, side: t.side, closed_at: t.closed_at })),
      });
    },
    get_recent_decisions: async () => {
      const rows = db.prepare('SELECT timestamp, agent, action, tool_name, reasoning FROM decisions ORDER BY timestamp DESC LIMIT 20').all();
      return JSON.stringify(rows);
    },
  };

  /**
   * Run Risk agent check. Returns { pass: boolean, reason: string, risk_flags: string[] }
   */
  async function runRiskCheck(signal, traceId) {
    const now = new Date().toISOString();

    // --- Hard rules (code-level, cannot be bypassed by LLM) ---

    // Check consecutive losses — count by position_groups if scaling enabled, else by trades
    let consecutiveLossCount = 0;
    const SCALING = config.SCALING;
    if (SCALING?.enabled) {
      // Count at group level: one abandoned group = one loss
      const recentGroups = db.prepare("SELECT pnl, closed_at FROM position_groups WHERE status IN ('closed', 'abandoned') ORDER BY closed_at DESC LIMIT 10").all();
      for (const g of recentGroups) { if ((g.pnl || 0) < 0) consecutiveLossCount++; else break; }
    } else {
      // Only count actual losses (pnl < 0), skip pnl=0 (unfilled orders marked closed)
      const recentTrades = db.prepare("SELECT pnl FROM trades WHERE status = 'closed' AND (pnl IS NOT NULL AND pnl != 0) ORDER BY closed_at DESC LIMIT 10").all();
      for (const t of recentTrades) { if (t.pnl < 0) consecutiveLossCount++; else break; }
    }
    const lossThresholdCount = SCALING?.enabled ? 5 : 3; // more lenient with scaling
    const consecutiveLosses = consecutiveLossCount >= lossThresholdCount;

    // Check last loss time for cooldown
    if (consecutiveLosses) {
      const lastLossQuery = SCALING?.enabled
        ? "SELECT closed_at FROM position_groups WHERE status IN ('closed', 'abandoned') AND pnl < 0 ORDER BY closed_at DESC LIMIT 1"
        : "SELECT closed_at FROM trades WHERE status = 'closed' AND pnl < 0 ORDER BY closed_at DESC LIMIT 1";
      const lastLoss = db.prepare(lastLossQuery).get();
      if (lastLoss?.closed_at) {
        const cooldownEnd = new Date(lastLoss.closed_at + 'Z').getTime() + 60 * 60 * 1000; // 1h
        if (Date.now() < cooldownEnd) {
          const reason = `连续${lossThresholdCount}笔亏损，冷却期至 ${new Date(cooldownEnd).toISOString().slice(11, 16)}`;
          postMessage('risk', 'executor', 'VETO', { reason }, traceId);
          return { pass: false, reason, risk_flags: ['consecutive_losses', 'cooldown_active'] };
        }
      }
    }

    // Check total active exposure across all symbols (scaling mode)
    if (SCALING?.enabled) {
      const activeGroups = db.prepare("SELECT total_size, symbol FROM position_groups WHERE status = 'active'").all();
      const totalExposure = activeGroups.reduce((s, g) => s + (g.total_size || 0), 0);
      if (totalExposure >= SCALING.max_exposure_eth) {
        const reason = `总敞口 ${totalExposure.toFixed(4)} 已达上限 ${SCALING.max_exposure_eth}`;
        return { pass: false, reason, risk_flags: ['max_exposure'] };
      }
    }

    // Check 24h cumulative loss > 5% — includes realized + unrealized
    const h24 = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const recent24h = db.prepare('SELECT pnl FROM trades WHERE status = ? AND closed_at > ?').all('closed', h24);
    let loss24h = recent24h.reduce((s, t) => s + Math.min(0, t.pnl || 0), 0);
    // Include unrealized PnL from open positions (floating losses count)
    // Primary: WS cache (instant, no API call). Fallback: REST API.
    let unrealizedLoss = 0;
    if (_ws.isHealthy()) {
      unrealizedLoss = Math.min(0, _ws.getUnrealizedPnL());
    } else {
      try {
        const posData = await bitgetRequest('GET', '/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT');
        const positions = Array.isArray(posData) ? posData : (posData?.list || []);
        unrealizedLoss = positions.reduce((s, p) => s + Math.min(0, parseFloat(p.unrealizedPL || '0')), 0);
      } catch (e) { _log.warn('unrealized_pnl_fetch_failed', { module: 'risk', error: e.message }); }
    }
    loss24h += unrealizedLoss;

    // Dynamic threshold: 5% of account equity
    // Primary: WS cache. Fallback: REST API.
    let equity = _ws.isHealthy() ? _ws.getEquity() : 0;
    if (equity <= 0) {
      try {
        const accts = await bitgetRequest('GET', '/api/v2/mix/account/accounts?productType=USDT-FUTURES').catch(() => []);
        equity = parseFloat((accts || []).find(a => a.marginCoin === 'USDT')?.accountEquity || '0');
      } catch (e) { _log.warn('equity_fetch_failed', { module: 'risk', error: e.message }); }
    }
    const lossThreshold = equity > 0 ? equity * 0.05 : 0;
    if (lossThreshold <= 0) {
      _log.warn('equity_unknown_veto', { module: 'risk' });
      return { pass: false, reason: '无法获取账户权益，暂停交易', risk_flags: ['equity_unknown'] };
    }
    if (loss24h < -lossThreshold) {
      const reason = `24小时累计亏损 ${loss24h.toFixed(2)} USDC (含浮亏)，超过安全阈值 (${lossThreshold.toFixed(2)})`;
      postMessage('risk', 'executor', 'VETO', { reason }, traceId);
      return { pass: false, reason, risk_flags: ['24h_loss_limit'] };
    }

    // --- Soft rules: let Risk agent LLM evaluate ---
    try {
      const result = await runAgent('risk', RISK_SYSTEM_PROMPT, RISK_TOOLS, RISK_EXECUTORS,
        `Review this trade signal and decide PASS or VETO:\n${JSON.stringify(signal, null, 2)}`,
        { trace_id: traceId, max_tokens: 400, timeout: 20000 }
      );

      // Extract verdict from submit_verdict tool call (structured, preferred)
      let verdict;
      const submitCall = result.toolCalls.find(t => t.name === 'submit_verdict');
      if (submitCall) {
        const args = typeof submitCall.args === 'string' ? JSON.parse(submitCall.args) : submitCall.args;
        if (args?.verdict && args?.reason) {
          verdict = args;
        } else {
          _log.warn('submit_verdict_incomplete', { module: 'risk', keys: Object.keys(args || {}) });
        }
      }
      if (!verdict) {
        // Fallback: legacy free-form text parsing
        try {
          const jsonStr = result.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          verdict = JSON.parse(jsonStr);
        } catch {
          _log.warn('verdict_parse_failed', { module: 'risk', raw: result.content.slice(0, 100) });
          verdict = { verdict: 'VETO', reason: 'Risk agent parse error, defaulting VETO', risk_flags: ['parse_error'] };
        }
      }

      const pass = verdict.verdict === 'PASS';
      postMessage('risk', 'executor', pass ? 'PASS' : 'VETO', verdict, traceId);

      _log.info('risk_verdict', { module: 'risk', verdict: verdict.verdict, reason: verdict.reason });
      try {
        insertDecision.run(now, 'risk', pass ? 'approve' : 'veto', '', '',
          JSON.stringify(verdict), `Risk check for signal`, verdict.reason, '', signal.confidence || 0, null);
      } catch (e) { _log.warn('caught_error', { module: 'risk', error: e.message }); }

      return { pass, reason: verdict.reason, risk_flags: verdict.risk_flags || [] };
    } catch (err) {
      _log.error('risk_agent_error', { module: 'risk', error: err.message });
      return { pass: false, reason: `Risk agent error: ${err.message}`, risk_flags: ['agent_error'] };
    }
  }

  return { runRiskCheck, RISK_TOOLS, RISK_EXECUTORS };
}
