/**
 * Strategist agent: evaluates active strategies against market conditions.
 */

export function createStrategist({ db, agentRunner, messageBus, cache }) {
  const { runAgent } = agentRunner;
  const { postMessage } = messageBus;
  const { insertDecision } = db;

  const STRATEGIST_SYSTEM_PROMPT = `You are the RIFI Strategist Agent. You manage trading strategies and evaluate market conditions against active goals.

Your workflow:
1. Call list_strategies to see active strategies
2. Call get_latest_analysis to see current market conditions
3. Call get_trade_stats to see recent performance
4. Evaluate: does the current market match any active strategy's entry criteria?
5. If yes, recommend a trade action. If no, explain why not.

Strategy templates you understand:
- grid: buy/sell within a price range at intervals
- dca: dollar-cost average at fixed intervals/amounts
- ma_cross: moving average crossover signals
- trend: ATR channel + dynamic stop-loss
- event: VIX threshold / news event triggers
- custom: user-defined rules

Respond with JSON:
{
  "active_strategies": <count>,
  "triggered": [{ "strategy_id": <id>, "action": "buy|sell|hold", "reason": "<Chinese>" }],
  "summary": "<1-2 sentence Chinese summary of strategy evaluation>"
}`;

  const STRATEGIST_TOOLS = [
    {
      type: 'function',
      function: {
        name: 'list_strategies',
        description: 'List all active trading strategies with their goals and parameters',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_latest_analysis',
        description: 'Get the latest market analysis from the Analyst agent (cached)',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_trade_stats',
        description: 'Get trading performance stats',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
  ];

  // get_trade_stats executor reuses risk's logic inline
  const STRATEGIST_EXECUTORS = {
    list_strategies: async () => {
      const rows = db.prepare('SELECT * FROM strategies WHERE status = ? ORDER BY created_at DESC').all('active');
      return JSON.stringify(rows.map(r => ({
        ...r,
        plan_json: r.plan_json ? JSON.parse(r.plan_json) : null,
        params_json: r.params_json ? JSON.parse(r.params_json) : null,
      })));
    },
    get_latest_analysis: async () => {
      const a = cache.crypto.analysis;
      if (!a) return JSON.stringify({ error: 'No analysis yet' });
      return JSON.stringify({
        macro_risk_score: a.macro_risk_score,
        crypto_sentiment: a.crypto_sentiment,
        technical_bias: a.technical_bias,
        recommended_action: a.recommended_action,
        confidence: a.confidence,
        briefing: a.briefing,
        timestamp: a.timestamp,
      });
    },
    get_trade_stats: async () => {
      const closed = db.prepare('SELECT * FROM trades WHERE status = ? ORDER BY closed_at DESC LIMIT 20').all('closed');
      const open = db.prepare('SELECT * FROM trades WHERE status = ? ORDER BY opened_at DESC').all('open');
      const wins = closed.filter(t => t.pnl > 0);
      const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
      const h24 = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const recent24h = closed.filter(t => t.closed_at && t.closed_at > h24);
      const loss24h = recent24h.reduce((s, t) => s + Math.min(0, t.pnl || 0), 0);
      let consecutiveLosses = 0;
      for (const t of closed) {
        if (t.pnl <= 0) consecutiveLosses++;
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
  };

  async function runStrategistCheck(analystSignal, traceId) {
    const activeCount = db.prepare('SELECT COUNT(*) as cnt FROM strategies WHERE status = ?').get('active').cnt;
    if (activeCount === 0) return null; // No strategies to evaluate

    try {
      const result = await runAgent('strategist', STRATEGIST_SYSTEM_PROMPT, STRATEGIST_TOOLS, STRATEGIST_EXECUTORS,
        `Evaluate active strategies against current market. Latest signal: ${JSON.stringify(analystSignal)}`,
        { trace_id: traceId, max_tokens: 600, timeout: 25000 }
      );

      let parsed;
      try {
        const jsonStr = result.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        parsed = JSON.parse(jsonStr);
      } catch {
        console.warn(`[Strategist] Parse failed: ${result.content.slice(0, 100)}`);
        return null;
      }

      console.log(`[Strategist] ${parsed.active_strategies} strategies, ${parsed.triggered?.length || 0} triggered`);

      try {
        insertDecision.run(new Date().toISOString(), 'strategist', 'evaluate', '', '',
          JSON.stringify(parsed), 'Strategy evaluation', parsed.summary || '', '', analystSignal.confidence || 0, null);
      } catch {}

      // If any strategy triggered, send through Risk gate
      if (parsed.triggered?.length > 0) {
        for (const trigger of parsed.triggered) {
          if (trigger.action !== 'hold') {
            postMessage('strategist', 'risk', 'STRATEGY_TRIGGER', trigger, traceId);
          }
        }
      }

      return parsed;
    } catch (err) {
      console.error(`[Strategist] Error: ${err.message}`);
      return null;
    }
  }

  return { runStrategistCheck };
}
