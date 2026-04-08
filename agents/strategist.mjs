/**
 * Strategist agent: evaluates compound strategies + manual strategies against market conditions.
 * Phase 3: now uses evaluateConditions for deterministic checks + LLM for judgment.
 */

import { evaluateConditions } from '../agent/cognition/conditions.mjs';
import { buildFeatureSnapshot } from '../agent/cognition/feature-builder.mjs';
import { evaluateTargetPositionDecision } from '../agent/cognition/target-position.mjs';
import { fetchCurrentMarketState } from '../backtest/market-state-loader.mjs';

export function createStrategist({ db, agentRunner, messageBus, cache, log, compound, bitgetClient, indicators, strategySelector }) {
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

  async function buildLiveFeatureSnapshot(symbol, timeframe) {
    let candles = [];
    let ticker = {};
    try {
      if (bitgetClient) {
        const rows = await bitgetClient.bitgetPublic(
          `/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${timeframe}&limit=220`
        );
        candles = (rows || []).map((k) => ({
          ts: parseInt(k[0], 10),
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5] || 0),
        })).reverse();
      }
    } catch (e) {
      _log.warn('strategist_candle_fetch_failed', { module: 'strategist', symbol, error: e.message });
    }

    try {
      if (bitgetClient) {
        const tickers = await bitgetClient.bitgetPublic('/api/v2/mix/market/tickers?productType=USDT-FUTURES');
        ticker = tickers?.find((t) => t.symbol === symbol) || {};
      }
    } catch (e) {
      _log.warn('strategist_ticker_fetch_failed', { module: 'strategist', symbol, error: e.message });
    }

    let currentState = null;
    try {
      if (bitgetClient) {
        currentState = await fetchCurrentMarketState({ db: db.db || db, bitgetClient, symbol, timeframe, log: _log });
      }
    } catch (e) {
      _log.warn('strategist_market_state_failed', { module: 'strategist', symbol, error: e.message });
    }

    const marketStates = [];
    try {
      const rawDb = db.db || db;
      const latestTs = candles[candles.length - 1]?.ts || Date.now();
      const recentStates = rawDb.prepare(
        'SELECT * FROM market_state_history WHERE pair = ? AND timeframe = ? AND ts <= ? ORDER BY ts DESC LIMIT 240'
      ).all(symbol, timeframe, latestTs).reverse();
      marketStates.push(...recentStates);
    } catch {}
    if (currentState) marketStates.push(currentState);

    return buildFeatureSnapshot({
      candles,
      marketStates,
      timeframe,
      ticker: {
        lastPr: ticker.lastPr,
        change24h: ticker.change24h,
        fundingRate: currentState?.funding_rate || ticker.fundingRate,
        usdtVolume: ticker.usdtVolume,
      },
    });
  }

  async function getCurrentExposurePct(symbol) {
    if (!bitgetClient) return 0;
    try {
      const accounts = await bitgetClient.bitgetRequest('GET', '/api/v2/mix/account/accounts?productType=USDT-FUTURES');
      const usdtBal = accounts?.find((a) => a.marginCoin === 'USDT');
      const equity = parseFloat(usdtBal?.accountEquity || usdtBal?.usdtEquity || usdtBal?.equity || '0');
      if (!equity) return 0;

      const posData = await bitgetClient.bitgetRequest('GET', '/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT');
      const positions = Array.isArray(posData) ? posData : (posData?.list || []);
      const pos = positions.find((p) => p.symbol === symbol && parseFloat(p.total || '0') > 0);
      if (!pos) return 0;
      const markPrice = parseFloat(pos.markPrice || pos.mark_price || pos.averageOpenPrice || '0');
      const total = parseFloat(pos.total || '0');
      const direction = pos.holdSide === 'long' ? 1 : -1;
      if (!markPrice || !total) return 0;
      return Number((((markPrice * total) / equity) * 100 * direction).toFixed(2));
    } catch (e) {
      _log.warn('strategist_exposure_failed', { module: 'strategist', symbol, error: e.message });
      return 0;
    }
  }

  const STRATEGIST_EXECUTORS = {
    list_strategies: async () => {
      const selectorActive = !!strategySelector?.hasSelection?.();
      const selectedVersion = selectorActive ? strategySelector.getSelectedVersion() : null;

      // Compound strategies (AI-generated)
      let compoundStrategies = [];
      try {
        const rows = selectorActive
          ? strategySelector.getEligibleStrategies()
          : db.prepare(
            "SELECT strategy_id, family_id, version_id, role, name, description, direction, symbols, confidence, status, evidence_json FROM compound_strategies WHERE status = 'active' ORDER BY confidence DESC"
          ).all();
        compoundStrategies = rows.map(s => ({
          ...s,
          symbols: JSON.parse(s.symbols || '[]'),
          evidence: JSON.parse(s.evidence_json || '{}'),
          target: JSON.parse(s.target_json || '{}'),
          execution: JSON.parse(s.execution_json || '{}'),
          source: 'compound',
        }));
      } catch {}

      // Legacy manual strategies
      let manual = [];
      if (!selectorActive) {
        try {
          manual = db.prepare("SELECT * FROM strategies WHERE status = 'active'").all().map(r => ({
            ...r, source: 'manual',
            plan_json: r.plan_json ? JSON.parse(r.plan_json) : null,
          }));
        } catch {}
      }

      return JSON.stringify({
        selector: selectorActive ? {
          selected_family_id: selectedVersion?.family_id || null,
          selected_version_id: selectedVersion?.version_id || null,
          selected_version_name: selectedVersion?.version_name || null,
          decision_mode: selectedVersion?.decision_mode || 'trigger',
        } : null,
        compound: compoundStrategies,
        manual,
        total: compoundStrategies.length + manual.length,
      });
    },

    evaluate_strategy: async ({ strategy_id }) => {
      if (!strategy_id) return JSON.stringify({ error: 'strategy_id required' });

      const strategy = db.prepare('SELECT * FROM compound_strategies WHERE strategy_id = ?').get(strategy_id);
      if (!strategy) return JSON.stringify({ error: `Strategy ${strategy_id} not found` });

      const symbols = JSON.parse(strategy.symbols || '[]');
      const entryConditions = JSON.parse(strategy.entry_conditions || '[]');
      const exitConditions = JSON.parse(strategy.exit_conditions || '[]');
      const timeframe = strategy.timeframe === 'any' ? '1H' : (strategy.timeframe || '1H');

      // Evaluate against each target symbol
      const results = [];
      for (const symbol of (symbols.length > 0 ? symbols : ['BTCUSDT'])) {
        const snap = await buildLiveFeatureSnapshot(symbol, timeframe);

        const entry = evaluateConditions(entryConditions, snap, 'and');
        const exit = evaluateConditions(exitConditions, snap, 'or');

        results.push({
          symbol, entry, exit,
          indicators: {
            rsi_14: snap.rsi_14, funding_rate: snap.funding_rate,
            change_24h: snap.change_24h, trend: snap.trend,
            price: snap.price, bb_position: snap.bb_position,
            regime: snap.regime,
            days_in_regime: snap.days_in_regime,
            bars_since_breakout: snap.bars_since_breakout,
            overhead_supply_score_90d: snap.overhead_supply_score_90d,
            oi_zscore_30d: snap.oi_zscore_30d,
          },
        });
      }

      return JSON.stringify({
        strategy_id, direction: strategy.direction, confidence: strategy.confidence,
        sizing: JSON.parse(strategy.sizing_json || '{}'),
        risk_params: JSON.parse(strategy.risk_params_json || '{}'),
        target: JSON.parse(strategy.target_json || '{}'),
        execution: JSON.parse(strategy.execution_json || '{}'),
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
      const compoundCount = strategySelector?.hasSelection?.()
        ? strategySelector.getEligibleStrategyIds().length
        : db.prepare("SELECT COUNT(*) as cnt FROM compound_strategies WHERE status = 'active'").get().cnt;
      const manualCount = strategySelector?.hasSelection?.()
        ? 0
        : db.prepare("SELECT COUNT(*) as cnt FROM strategies WHERE status = 'active'").get().cnt;
      hasStrategies = (compoundCount + manualCount) > 0;
    } catch {}

    if (!hasStrategies) return null;

    const selectedVersion = strategySelector?.getSelectedVersion?.();
    if (selectedVersion?.decision_mode === 'target_position') {
      try {
        const strategies = strategySelector.getEligibleStrategies();
        const symbol = 'BTCUSDT';
        const timeframe = selectedVersion.version_id === 'wei2_0' ? '1H' : '1H';
        const features = await buildLiveFeatureSnapshot(symbol, timeframe);
        const currentExposurePct = await getCurrentExposurePct(symbol);
        const activeTarget = db.getActiveStrategyTarget?.(symbol, selectedVersion.family_id, selectedVersion.version_id) || null;
        const decision = evaluateTargetPositionDecision({
          strategies,
          features,
          rules: strategySelector.getScopedRules(),
          currentExposurePct,
          activeTarget,
        });
        const targetDecision = {
          ...decision,
          symbol,
          family_id: selectedVersion.family_id,
          version_id: selectedVersion.version_id,
          action: 'target_position',
          feature_hints: {
            atr_pct: features.atr_pct || 0,
            bb_width: features.bb_width || 0,
            price: features.price || 0,
          },
        };
        const parsed = {
          active_strategies: strategies.length,
          triggered: [targetDecision],
          target_decision: targetDecision,
          summary: targetDecision.reason,
        };
        try {
          insertDecision.run(new Date().toISOString(), 'strategist', 'target_position', '', '',
            JSON.stringify(parsed), 'Wei2 target-position evaluation', parsed.summary || '', '', analystSignal.confidence || 0, null);
        } catch {}
        postMessage('strategist', 'risk', 'STRATEGY_TRIGGER', targetDecision, traceId);
        _log.info('strategist_target_result', {
          module: 'strategist',
          strategy_id: targetDecision.strategy_id,
          target_exposure_pct: targetDecision.target_exposure_pct,
          delta_exposure_pct: targetDecision.delta_exposure_pct,
        });
        return parsed;
      } catch (err) {
        _log.error('strategist_target_error', { module: 'strategist', error: err.message });
        return null;
      }
    }

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
