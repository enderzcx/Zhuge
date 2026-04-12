/**
 * Risk agent: LLM-based soft evaluation only.
 *
 * 道枢坐标: (Harness, Philosophy)
 * Hard rules have been extracted to mandate-gate.mjs (Harness, Keystone).
 * This agent assumes mandate gate has already passed before being called.
 */

export function createRiskAgent({ db, config, agentRunner, messageBus, log }) {
  const _log = log || { info: console.log, warn: console.warn, error: console.error };
  const { runAgent } = agentRunner;
  const { postMessage } = messageBus;
  const { insertDecision } = db;

  const RISK_SYSTEM_PROMPT = `You are the RIFI Risk Agent. Your job is to evaluate trade signals using soft judgment and decide PASS or VETO.

IMPORTANT: Hard rules (24h loss limit, consecutive loss cooldown, exposure limits) have already been checked by the Mandate Gate before you run. You do NOT need to re-check those. Focus on soft judgment only.

Soft rules (use your judgment):
- Analyst confidence < 60 → lean toward VETO
- Same direction position already open → warn, lean toward VETO unless strong signal
- Signal conflicts with recent trade direction in last 1h → extra caution

Your workflow:
1. Call get_trade_stats to check recent performance context
2. Call get_recent_decisions to see what happened recently
3. Evaluate the signal using soft rules and your judgment
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
   * @param {object} signal
   * @param {string} traceId
   * @param {object} [opts] - { isScout: bool } — scout positions get relaxed rules
   */
  async function runRiskCheck(signal, traceId, opts = {}) {
    const now = new Date().toISOString();
    const isScout = opts.isScout || false;

    // Hard rules are now in mandate-gate.mjs — caller must run mandateGate.check() first.
    // This function only runs LLM soft judgment.

    // --- Soft rules: let Risk agent LLM evaluate ---
    // Scout positions use a relaxed prompt: lower confidence bar, ignore consecutive losses
    const scoutOverride = isScout
      ? `\n\nIMPORTANT: This is a SCOUT position (smallest size, minimal risk). Be LENIENT:\n- Confidence >= 50 is acceptable (not 60)\n- Ignore consecutive loss history for scouts (hard cooldown already handled by Mandate Gate)\n- Only VETO if there's a clear soft red flag (extreme macro risk > 90, very low confidence)\n- Default to PASS unless clearly dangerous`
      : '';
    try {
      const result = await runAgent('risk', RISK_SYSTEM_PROMPT + scoutOverride, RISK_TOOLS, RISK_EXECUTORS,
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
