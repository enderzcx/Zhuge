/**
 * Strategist agent: evaluates compound strategies + manual strategies against market conditions.
 * Phase 3: now uses evaluateConditions for deterministic checks + LLM for judgment.
 */

import { evaluateConditions, buildIndicatorSnapshot } from '../agent/cognition/conditions.mjs';

export function createStrategist({ db, agentRunner, messageBus, cache, log, compound, bitgetClient, indicators }) {
  const _log = log || { info: console.log, warn: console.warn, error: console.error };
  const { runAgent } = agentRunner;
  const { postMessage } = messageBus;
  const { insertDecision } = db;

  const STRATEGIST_SYSTEM_PROMPT = `You are the Strategist Agent for 诸葛 trading system. You evaluate AI-generated compound strategies and manual strategies against current market conditions.

Your workflow:
1. Call list_strategies to see active + proposed strategies
2. For each active strategy, call evaluate_strategy to check if entry/exit conditions match
3. Call get_latest_analysis for the analyst's current view
4. Decide: which strategies should trigger? Which should wait?

Strategy evaluation rules:
- Only trigger strategies with status='active' (never trigger 'proposed' strategies)
- Only trigger when match_score >= 0.8 (80% of weighted conditions met)
- If multiple strategies want to trigger for the same symbol, pick the highest confidence one
- Never trigger a strategy that conflicts with the analyst's overall view (e.g. long strategy when analyst says strong_sell)
- Consider trade_stats to avoid over-trading (respect max_daily_loss)

Respond with JSON:
{
  "active_strategies": <count>,
  "triggered": [
    {
      "strategy_id": "<id>",
      "action": "open_long | open_short | close | hold",
      "symbol": "BTCUSDT",
      "match_score": 0.85,
      "params": { "leverage": 8, "margin_usdt": 3, "sl_pct": 0.03, "tp_pct": 0.06 },
      "reason": "<Chinese explanation>"
    }
  ],
  "summary": "<1-2 sentence Chinese summary>"
}`;

  const STRATEGIST_TOOLS = [
    {
      type: 'function',
      function: {
        name: 'list_strategies',
        description: 'List all strategies: AI-generated compound strategies + manual strategies',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'evaluate_strategy',
        description: 'Deterministically check if a strategy\'s entry/exit conditions match current market. Returns match_score and condition details.',
        parameters: {
          type: 'object',
          properties: {
            strategy_id: { type: 'string', description: 'compound strategy ID to evaluate' },
          },
          required: ['strategy_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_latest_analysis',
        description: 'Get the latest market analysis from the Analyst agent',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_trade_stats',
        description: 'Get trading performance stats (open positions, win rate, PnL, 24h losses)',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
  ];

  const STRATEGIST_EXECUTORS = {
    list_strategies: async () => {
      // Compound strategies (AI-generated)
      let compoundStrategies = [];
      try {
        compoundStrategies = db.prepare(
          "SELECT strategy_id, name, description, direction, symbols, confidence, status, evidence_json FROM compound_strategies WHERE status = 'active' ORDER BY confidence DESC"
        ).all().map(s => ({
          ...s,
          symbols: JSON.parse(s.symbols || '[]'),
          evidence: JSON.parse(s.evidence_json || '{}'),
          source: 'compound',
        }));
      } catch {}

      // Legacy manual strategies
      let manual = [];
      try {
        manual = db.prepare("SELECT * FROM strategies WHERE status = 'active'").all().map(r => ({
          ...r, source: 'manual',
          plan_json: r.plan_json ? JSON.parse(r.plan_json) : null,
        }));
      } catch {}

      return JSON.stringify({ compound: compoundStrategies, manual, total: compoundStrategies.length + manual.length });
    },

    evaluate_strategy: async ({ strategy_id }) => {
      if (!strategy_id) return JSON.stringify({ error: 'strategy_id required' });

      const strategy = db.prepare('SELECT * FROM compound_strategies WHERE strategy_id = ?').get(strategy_id);
      if (!strategy) return JSON.stringify({ error: `Strategy ${strategy_id} not found` });

      const symbols = JSON.parse(strategy.symbols || '[]');
      const entryConditions = JSON.parse(strategy.entry_conditions || '[]');
      const exitConditions = JSON.parse(strategy.exit_conditions || '[]');

      // Evaluate against each target symbol
      const results = [];
      for (const symbol of (symbols.length > 0 ? symbols : ['BTCUSDT'])) {
        // Build indicator snapshot from available data
        let snap = {};
        try {
          // Try to get candles from Bitget
          if (bitgetClient) {
            const candles = await bitgetClient.bitgetPublic(
              `/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=1H&limit=50`
            );
            if (candles?.length) {
              const closes = candles.map(k => parseFloat(k[4])).reverse();
              const highs = candles.map(k => parseFloat(k[2])).reverse();
              const lows = candles.map(k => parseFloat(k[3])).reverse();

              const tickers = await bitgetClient.bitgetPublic('/api/v2/mix/market/tickers?productType=USDT-FUTURES');
              const ticker = tickers?.find(t => t.symbol === symbol) || {};
              snap = buildIndicatorSnapshot(closes, highs, lows, ticker);
            }
          }
        } catch (e) {
          _log.warn('indicator_fetch_failed', { module: 'strategist', symbol, error: e.message });
        }

        const entry = evaluateConditions(entryConditions, snap, 'and');
        const exit = evaluateConditions(exitConditions, snap, 'or');

        results.push({
          symbol, entry, exit,
          indicators: {
            rsi_14: snap.rsi_14, funding_rate: snap.funding_rate,
            change_24h: snap.change_24h, trend: snap.trend,
            price: snap.price, bb_position: snap.bb_position,
          },
        });
      }

      return JSON.stringify({
        strategy_id, direction: strategy.direction, confidence: strategy.confidence,
        sizing: JSON.parse(strategy.sizing_json || '{}'),
        risk_params: JSON.parse(strategy.risk_params_json || '{}'),
        evaluations: results,
      });
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
        open_positions: open.map(t => ({ pair: t.pair, side: t.side, amount: t.amount, entry_price: t.entry_price, strategy_id: t.strategy_id })),
      });
    },
  };

  async function runStrategistCheck(analystSignal, traceId) {
    // Check both compound strategies and manual strategies
    let hasStrategies = false;
    try {
      const compoundCount = db.prepare("SELECT COUNT(*) as cnt FROM compound_strategies WHERE status = 'active'").get().cnt;
      const manualCount = db.prepare("SELECT COUNT(*) as cnt FROM strategies WHERE status = 'active'").get().cnt;
      hasStrategies = (compoundCount + manualCount) > 0;
    } catch {}

    if (!hasStrategies) return null;

    try {
      const result = await runAgent('strategist', STRATEGIST_SYSTEM_PROMPT, STRATEGIST_TOOLS, STRATEGIST_EXECUTORS,
        `Evaluate all active strategies against current market. Latest analyst signal: ${JSON.stringify(analystSignal)}`,
        { trace_id: traceId, max_tokens: 800, timeout: 45000 }
      );

      let parsed;
      try {
        const jsonStr = result.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        parsed = JSON.parse(jsonStr);
      } catch {
        _log.warn('parse_failed', { module: 'strategist', raw: result.content.slice(0, 100) });
        return null;
      }

      _log.info('strategist_result', { module: 'strategist', active: parsed.active_strategies, triggered: parsed.triggered?.length || 0 });

      try {
        insertDecision.run(new Date().toISOString(), 'strategist', 'evaluate', '', '',
          JSON.stringify(parsed), 'Strategy evaluation', parsed.summary || '', '', analystSignal.confidence || 0, null);
      } catch (e) { _log.warn('caught_error', { module: 'strategist', error: e.message }); }

      // Strategy triggers → sent to pipeline for risk gate + execution
      if (parsed.triggered?.length > 0) {
        for (const trigger of parsed.triggered) {
          if (trigger.action !== 'hold') {
            postMessage('strategist', 'risk', 'STRATEGY_TRIGGER', trigger, traceId);
          }
        }
      }

      return parsed;
    } catch (err) {
      _log.error('strategist_error', { module: 'strategist', error: err.message });
      return null;
    }
  }

  return { runStrategistCheck };
}
