/**
 * Backtest engine: replay historical candles through strategies.
 * Supports both legacy trigger-style strategies and Wei2.0 target-position mode.
 */

import { evaluateConditions } from '../agent/cognition/conditions.mjs';
import { buildFeatureSnapshot } from '../agent/cognition/feature-builder.mjs';
import { evaluateTargetPositionDecision } from '../agent/cognition/target-position.mjs';
import { createSimulator } from './simulator.mjs';
import { generateReport } from './report.mjs';

const LOOKBACK = 100;

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function buildStats(trades, initialBalance, finalBalance, maxDrawdown = 0) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
  const returns = trades.map((t) => t.pnlPct || 0);
  const mean = returns.length ? returns.reduce((s, v) => s + v, 0) / returns.length : 0;
  const variance = returns.length > 1
    ? returns.reduce((s, v) => s + ((v - mean) ** 2), 0) / (returns.length - 1)
    : 0;
  const sharpe = variance > 0 ? mean / Math.sqrt(variance) : 0;

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) + '%' : 'N/A',
    totalPnl: totalPnl.toFixed(2),
    avgWin: avgWin.toFixed(2),
    avgLoss: avgLoss.toFixed(2),
    profitFactor: avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : 'Inf',
    maxDrawdown: (maxDrawdown * 100).toFixed(1) + '%',
    finalBalance: finalBalance.toFixed(2),
    returnPct: ((finalBalance - initialBalance) / initialBalance * 100).toFixed(1) + '%',
    sharpeRatio: sharpe.toFixed(2),
    openPositions: 0,
  };
}

function calculateSpacingBasis(features) {
  return Math.max(features.atr_pct || 0, (features.bb_width || 0) / 2, 0.0025);
}

function generateLadderOrders({ currentExposurePct, decision, features, candle, equity }) {
  const execution = decision.execution || {};
  const rungCount = execution.rung_count || 3;
  const sizeCurve = execution.size_curve || [0.3, 0.3, 0.4];
  const spacingMultipliers = execution.spacing_multipliers || [0.25, 0.5, 0.9];
  const spacingBasis = calculateSpacingBasis(features);
  const delta = Number((decision.target_exposure_pct - currentExposurePct).toFixed(2));
  if (Math.abs(delta) < 0.1) return [];

  const targetSide = decision.target_exposure_pct > 0 ? 'long' : decision.target_exposure_pct < 0 ? 'short' : 'flat';
  const currentSide = currentExposurePct > 0 ? 'long' : currentExposurePct < 0 ? 'short' : 'flat';
  const reducing = targetSide === 'flat' || (currentSide !== 'flat' && currentSide !== targetSide);
  const side = reducing
    ? (currentExposurePct > 0 ? 'sell' : 'buy')
    : (delta > 0 ? 'buy' : 'sell');
  const intent = reducing ? 'reduce' : 'open';
  const reduceOnly = reducing ? 1 : 0;
  const absDelta = Math.abs(delta);

  return Array.from({ length: rungCount }, (_, idx) => {
    const share = sizeCurve[idx] || 0;
    const rungExposurePct = absDelta * share;
    const notional = (equity * rungExposurePct) / 100;
    const size = candle.close > 0 ? Number((notional / candle.close).toFixed(6)) : 0;
    const multiplier = spacingMultipliers[idx] || spacingMultipliers[spacingMultipliers.length - 1] || 0.5;
    const bias = spacingBasis * multiplier;
    let price = candle.close;
    if (side === 'buy') {
      price = intent === 'open' ? candle.close * (1 - bias) : candle.close * (1 - bias);
    } else {
      price = intent === 'open' ? candle.close * (1 + bias) : candle.close * (1 + bias);
    }
    return {
      rung_index: idx,
      intent,
      side,
      reduce_only: reduceOnly,
      target_exposure_pct: decision.target_exposure_pct,
      size,
      price: Number(price.toFixed(2)),
      status: 'working',
    };
  }).filter((order) => order.size > 0);
}

function fillFraction(order, candle) {
  if (order.side === 'buy') {
    if (candle.low > order.price) return 0;
    return candle.close <= order.price ? 1 : 0.5;
  }
  if (candle.high < order.price) return 0;
  return candle.close >= order.price ? 1 : 0.5;
}

function reconcilePositionFill(state, order, fillSize, price, ts, reason = 'ladder_fill') {
  if (fillSize <= 0) return null;
  const currentSide = state.position.side;
  const orderSide = order.side === 'buy' ? 'long' : 'short';

  if (currentSide === 'flat') {
    state.position = {
      side: orderSide,
      size: fillSize,
      avgEntry: price,
      openedAt: ts,
      strategy_id: state.currentStrategyId,
      target_exposure_pct: order.target_exposure_pct,
      expiresAt: state.currentExpiresAt,
    };
    return null;
  }

  if (currentSide === orderSide && !order.reduce_only) {
    const total = state.position.size + fillSize;
    state.position.avgEntry = ((state.position.avgEntry * state.position.size) + (price * fillSize)) / total;
    state.position.size = total;
    state.position.target_exposure_pct = order.target_exposure_pct;
    state.position.expiresAt = state.currentExpiresAt;
    return null;
  }

  const closeSize = Math.min(state.position.size, fillSize);
  const direction = currentSide === 'long' ? 1 : -1;
  const pnlPct = direction * (price - state.position.avgEntry) / state.position.avgEntry;
  const pnl = closeSize * (price - state.position.avgEntry) * direction;
  state.balance += pnl;
  state.equity = state.balance;
  if (state.balance > state.peakBalance) state.peakBalance = state.balance;
  const dd = (state.peakBalance - state.balance) / state.peakBalance;
  state.maxDrawdown = Math.max(state.maxDrawdown, dd);

  const trade = {
    side: currentSide,
    entryPrice: state.position.avgEntry,
    exitPrice: price,
    pnl,
    pnlPct,
    openedAt: state.position.openedAt,
    closedAt: ts,
    reason,
    strategy_id: state.position.strategy_id,
  };

  state.position.size -= closeSize;
  if (state.position.size <= 1e-8) {
    state.position = { side: 'flat', size: 0, avgEntry: 0, openedAt: null, strategy_id: null, target_exposure_pct: 0, expiresAt: null };
  }
  return trade;
}

function closeEntirePosition(state, price, ts, reason) {
  if (state.position.side === 'flat' || state.position.size <= 0) return null;
  return reconcilePositionFill(state, { side: state.position.side === 'long' ? 'sell' : 'buy', reduce_only: 1 }, state.position.size, price, ts, reason);
}

function runLegacyBacktest({ strategy, candles, startIndex, initialBalance }) {
  const entryConditions = parseJson(strategy.entry_conditions, []);
  const exitConditions = parseJson(strategy.exit_conditions, []);
  const sizing = parseJson(strategy.sizing_json, {});
  const riskParams = parseJson(strategy.risk_params_json, {});
  const direction = strategy.direction || 'long';

  const sim = createSimulator({
    initialBalance,
    defaultLeverage: sizing.leverage || 10,
    maxPositions: 1,
  });
  const decisions = [];

  for (let i = startIndex; i < candles.length; i++) {
    const window = candles.slice(i - LOOKBACK, i + 1);
    const current = candles[i];
    const features = buildFeatureSnapshot({ candles: window, timeframe: strategy.timeframe || '1H' });
    const hadPositionBeforeTPSL = sim.positions.length > 0;
    const openSide = sim.positions[0]?.side;

    if (openSide === 'long') {
      sim.checkPositions(current.low, current.ts);
      sim.checkPositions(current.high, current.ts);
    } else if (openSide === 'short') {
      sim.checkPositions(current.high, current.ts);
      sim.checkPositions(current.low, current.ts);
    }

    const hadPosition = hadPositionBeforeTPSL;
    if (hadPosition && exitConditions.length > 0) {
      const exit = evaluateConditions(exitConditions, features, 'or');
      if (exit.met) {
        const pos = sim.positions[0];
        sim.closePosition(pos.id, current.close, current.ts, 'exit_signal');
        decisions.push({ ts: current.ts, action: 'close', reason: exit.matched.join(', '), price: current.close });
        continue;
      }
    }

    const justClosed = hadPosition && sim.positions.length === 0;
    if (!justClosed && sim.positions.length === 0) {
      const entry = evaluateConditions(entryConditions, features, 'and');
      if (entry.met && entry.score >= 0.8) {
        const side = direction === 'both'
          ? (features.trend === 'bullish' ? 'long' : 'short')
          : direction;
        const pos = sim.openPosition({
          symbol: strategy.symbol || 'BTCUSDT',
          side,
          price: current.close,
          leverage: sizing.leverage || 10,
          margin: sizing.margin_usdt || initialBalance * 0.05,
          sl_pct: riskParams.sl_pct || 0.03,
          tp_pct: riskParams.tp_pct || 0.06,
          ts: current.ts,
        });
        if (pos) {
          decisions.push({ ts: current.ts, action: 'open', side, reason: entry.matched.join(', '), price: current.close, score: entry.score });
        }
      }
    }
  }

  const lastCandle = candles[candles.length - 1];
  for (const pos of sim.positions) {
    sim.closePosition(pos.id, lastCandle.close, lastCandle.ts, 'backtest_end');
  }

  return {
    stats: sim.getStats(),
    trades: sim.trades,
    decisions,
    report: generateReport(sim.trades, initialBalance),
    candleCount: candles.length,
    time_stop_count: 0,
    partial_fill_count: 0,
    target_changes: 0,
    ladder_order_count: 0,
  };
}

function runTargetPositionBacktest({ db, strategy, candles, marketStates, initialBalance }) {
  const selectedStrategies = db.prepare(
    "SELECT * FROM compound_strategies WHERE status = 'active' AND family_id = ? AND version_id = ? ORDER BY confidence DESC, strategy_id ASC"
  ).all(strategy.family_id, strategy.version_id);

  const rules = db.prepare(`
    SELECT * FROM compound_rules
    WHERE status = 'active' AND (COALESCE(scope, 'global') = 'global' OR (family_id = ? AND version_id = ?))
    ORDER BY confidence DESC
  `).all(strategy.family_id, strategy.version_id)
    .map((row) => ({ ...row, param_changes: parseJson(row.param_changes_json, {}) }));

  const state = {
    balance: initialBalance,
    equity: initialBalance,
    peakBalance: initialBalance,
    maxDrawdown: 0,
    position: { side: 'flat', size: 0, avgEntry: 0, openedAt: null, strategy_id: null, target_exposure_pct: 0, expiresAt: null },
    ladderOrders: [],
    currentStrategyId: null,
    currentExpiresAt: null,
  };

  const trades = [];
  const decisions = [];
  let timeStopCount = 0;
  let partialFillCount = 0;
  let targetChanges = 0;
  let ladderOrderCount = 0;
  let previousTarget = null;

  for (let i = LOOKBACK; i < candles.length; i++) {
    const candle = candles[i];
    const window = candles.slice(i - LOOKBACK, i + 1);
    const stateWindow = marketStates.filter((row) => row.ts <= candle.ts).slice(-220);
    const features = buildFeatureSnapshot({
      candles: window,
      marketStates: stateWindow,
      timeframe: strategy.timeframe || '1H',
      ticker: {
        lastPr: candle.close,
        fundingRate: stateWindow[stateWindow.length - 1]?.funding_rate || 0,
        usdtVolume: candle.volume || 0,
      },
    });

    if (state.position.expiresAt && candle.ts >= state.position.expiresAt && state.position.side !== 'flat') {
      const trade = closeEntirePosition(state, candle.open, candle.ts, 'time_stop');
      if (trade) {
        trades.push(trade);
        decisions.push({ ts: candle.ts, action: 'time_stop', price: candle.open, strategy_id: trade.strategy_id });
        timeStopCount++;
      }
      state.ladderOrders = [];
    }

    const currentExposurePct = state.position.side === 'flat'
      ? 0
      : Number((((state.position.size * candle.close) / state.equity) * 100 * (state.position.side === 'long' ? 1 : -1)).toFixed(2));
    const decision = evaluateTargetPositionDecision({
      strategies: selectedStrategies,
      features,
      rules,
      currentExposurePct,
      activeTarget: state.position.side === 'flat' ? null : { strategy_id: state.position.strategy_id, execution: parseJson(strategy.execution_json, {}) },
    });

    const nextTarget = `${decision.strategy_id || 'flat'}:${decision.target_exposure_pct}:${decision.execution_style}`;
    if (nextTarget !== previousTarget || (state.ladderOrders.length === 0 && Math.abs(decision.delta_exposure_pct) >= 0.1)) {
      targetChanges++;
      previousTarget = nextTarget;
      state.currentStrategyId = decision.strategy_id;
      state.currentExpiresAt = decision.max_hold_minutes ? candle.ts + decision.max_hold_minutes * 60000 : null;
      state.ladderOrders = generateLadderOrders({
        currentExposurePct,
        decision,
        features,
        candle,
        equity: state.equity,
      });
      ladderOrderCount += state.ladderOrders.length;
      decisions.push({
        ts: candle.ts,
        action: 'target_update',
        strategy_id: decision.strategy_id,
        target_exposure_pct: decision.target_exposure_pct,
        delta_exposure_pct: decision.delta_exposure_pct,
      });
    }

    const remainingOrders = [];
    for (const order of state.ladderOrders) {
      const fraction = fillFraction(order, candle);
      if (!fraction) {
        remainingOrders.push(order);
        continue;
      }
      if (fraction < 1) partialFillCount++;
      const fillSize = order.size * fraction;
      const trade = reconcilePositionFill(state, order, fillSize, order.price, candle.ts, order.reduce_only ? 'ladder_reduce' : 'ladder_fill');
      if (trade) trades.push(trade);
      if (fraction < 1) {
        remainingOrders.push({ ...order, size: Number((order.size - fillSize).toFixed(6)) });
      }
    }
    state.ladderOrders = remainingOrders.filter((order) => order.size > 0.000001);
  }

  const lastCandle = candles[candles.length - 1];
  const finalTrade = closeEntirePosition(state, lastCandle.close, lastCandle.ts, 'backtest_end');
  if (finalTrade) trades.push(finalTrade);

  const stats = buildStats(trades, initialBalance, state.balance, state.maxDrawdown);
  return {
    stats,
    trades,
    decisions,
    report: generateReport(trades, initialBalance),
    candleCount: candles.length,
    time_stop_count: timeStopCount,
    partial_fill_count: partialFillCount,
    target_changes: targetChanges,
    ladder_order_count: ladderOrderCount,
  };
}

export function runBacktest({ db, symbol, timeframe, strategyId, startTs, endTs, initialBalance = 100, log }) {
  const _log = log || { info() {}, warn() {} };

  const strategy = db.prepare('SELECT * FROM compound_strategies WHERE strategy_id = ?').get(strategyId);
  if (!strategy) throw new Error(`Strategy not found: ${strategyId}`);

  let query = 'SELECT ts, open, high, low, close, volume FROM backtest_candles WHERE pair = ? AND timeframe = ?';
  const params = [symbol, timeframe];
  if (startTs) { query += ' AND ts >= ?'; params.push(startTs); }
  if (endTs) { query += ' AND ts <= ?'; params.push(endTs); }
  query += ' ORDER BY ts ASC';
  const candles = db.prepare(query).all(...params);
  if (candles.length < LOOKBACK + 10) {
    throw new Error(`Not enough candles: ${candles.length} (need ${LOOKBACK + 10}+). Load more data first.`);
  }

  const targetMode = !!parseJson(strategy.target_json, {}).target_exposure_pct;
  const marketStates = db.prepare(
    'SELECT * FROM market_state_history WHERE pair = ? AND timeframe = ? ORDER BY ts ASC'
  ).all(symbol, timeframe);

  const result = targetMode
    ? runTargetPositionBacktest({ db, strategy, candles, marketStates, initialBalance })
    : runLegacyBacktest({ strategy, candles, startIndex: LOOKBACK, initialBalance });

  _log.info('backtest_done', {
    module: 'backtest',
    strategyId,
    symbol,
    timeframe,
    candles: candles.length,
    trades: result.stats.totalTrades,
    winRate: result.stats.winRate,
    pnl: result.stats.totalPnl,
    timeStops: result.time_stop_count,
    partialFills: result.partial_fill_count,
  });

  return result;
}
