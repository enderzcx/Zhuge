/**
 * Backtest engine — replay historical candles through compound strategy conditions.
 * Deterministic: no LLM, no API calls, fully reproducible.
 */

import { evaluateConditions, buildIndicatorSnapshot } from '../agent/cognition/conditions.mjs';
import { createSimulator } from './simulator.mjs';
import { generateReport } from './report.mjs';

const LOOKBACK = 100; // candles needed for indicator calculation

/**
 * Run a backtest for a compound strategy against historical candles.
 *
 * @param {object} params
 * @param {object} params.db - raw better-sqlite3 instance
 * @param {string} params.symbol - e.g. 'BTCUSDT'
 * @param {string} params.timeframe - e.g. '1H'
 * @param {string} params.strategyId - compound strategy ID
 * @param {number} [params.startTs] - start timestamp (defaults to earliest available)
 * @param {number} [params.endTs] - end timestamp (defaults to latest)
 * @param {number} [params.initialBalance] - virtual starting balance (default 100 USDT)
 * @param {object} [params.log]
 * @returns {{ stats, trades, report, candles }}
 */
export function runBacktest({ db, symbol, timeframe, strategyId, startTs, endTs, initialBalance = 100, log }) {
  const _log = log || { info() {}, warn() {} };

  // 1. Load strategy
  const strategy = db.prepare('SELECT * FROM compound_strategies WHERE strategy_id = ?').get(strategyId);
  if (!strategy) throw new Error(`Strategy not found: ${strategyId}`);

  const entryConditions = JSON.parse(strategy.entry_conditions || '[]');
  const exitConditions = JSON.parse(strategy.exit_conditions || '[]');
  const sizing = JSON.parse(strategy.sizing_json || '{}');
  const riskParams = JSON.parse(strategy.risk_params_json || '{}');
  const direction = strategy.direction || 'long';

  if (entryConditions.length === 0) throw new Error('Strategy has no entry conditions');

  // 2. Load candles
  let query = 'SELECT ts, open, high, low, close, volume FROM backtest_candles WHERE pair = ? AND timeframe = ?';
  const params = [symbol, timeframe];
  if (startTs) { query += ' AND ts >= ?'; params.push(startTs); }
  if (endTs) { query += ' AND ts <= ?'; params.push(endTs); }
  query += ' ORDER BY ts ASC';

  const candles = db.prepare(query).all(...params);
  if (candles.length < LOOKBACK + 10) {
    throw new Error(`Not enough candles: ${candles.length} (need ${LOOKBACK + 10}+). Load more data first.`);
  }

  // 3. Initialize simulator
  const sim = createSimulator({
    initialBalance,
    defaultLeverage: sizing.leverage || 10,
    maxPositions: 1, // one position at a time per backtest
  });

  // 4. Walk through candles
  const decisions = [];

  for (let i = LOOKBACK; i < candles.length; i++) {
    const window = candles.slice(i - LOOKBACK, i + 1);
    const closes = window.map(c => c.close);
    const highs = window.map(c => c.high);
    const lows = window.map(c => c.low);
    const current = candles[i];

    // Build indicator snapshot
    const indicators = buildIndicatorSnapshot(closes, highs, lows, {
      lastPr: current.close,
      change24h: i >= 24 ? ((current.close - candles[i - 24].close) / candles[i - 24].close) : 0,
      fundingRate: 0, // not available in historical candles
      usdtVolume: current.volume || 0,
    });

    // Check TP/SL first
    sim.checkPositions(current.high, current.ts); // check against high (intrabar)
    sim.checkPositions(current.low, current.ts);  // check against low

    const hasOpen = sim.positions.length > 0;

    // Exit check (only if we have an open position)
    if (hasOpen && exitConditions.length > 0) {
      const exit = evaluateConditions(exitConditions, indicators, 'or');
      if (exit.met) {
        const pos = sim.positions[0];
        sim.closePosition(pos.id, current.close, current.ts, 'exit_signal');
        decisions.push({ ts: current.ts, action: 'close', reason: exit.matched.join(', '), price: current.close });
        continue;
      }
    }

    // Entry check (only if no open position)
    if (!hasOpen) {
      const entry = evaluateConditions(entryConditions, indicators, 'and');
      if (entry.met && entry.score >= 0.8) {
        const side = direction === 'both'
          ? (indicators.trend === 'bullish' ? 'long' : 'short')
          : direction;
        const pos = sim.openPosition({
          symbol, side,
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

  // Close any remaining positions at last candle price
  const lastCandle = candles[candles.length - 1];
  for (const pos of sim.positions) {
    sim.closePosition(pos.id, lastCandle.close, lastCandle.ts, 'backtest_end');
  }

  // 5. Generate report
  const stats = sim.getStats();
  const report = generateReport(sim.trades, initialBalance);

  _log.info('backtest_done', {
    module: 'backtest', strategyId, symbol, timeframe,
    candles: candles.length, trades: stats.totalTrades, winRate: stats.winRate, pnl: stats.totalPnl,
  });

  return { stats, trades: sim.trades, decisions, report, candleCount: candles.length };
}
