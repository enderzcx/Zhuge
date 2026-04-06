/**
 * Deterministic condition evaluator for compound strategies.
 * Pure functions — no LLM, no side effects, no DB access.
 *
 * Used by strategist (evaluate strategy conditions) and scanner (match momentum candidates).
 */

import { calcRSI, calcBollinger } from '../../market/indicators.mjs';

/**
 * Evaluate a list of conditions against current market indicators.
 * @param {Array} conditions - from compound_strategies entry/exit_conditions
 * @param {Object} indicators - current market state { rsi_14, funding_rate, volume_ratio, ... }
 * @param {'and'|'or'} logic - 'and' = all must match (entry), 'or' = any match (exit)
 * @returns {{ met: boolean, score: number, matched: string[], missed: string[] }}
 */
export function evaluateConditions(conditions, indicators, logic = 'and') {
  if (!conditions?.length) return { met: logic === 'and', score: logic === 'and' ? 1 : 0, matched: [], missed: [] };

  const results = conditions.map(c => {
    const val = indicators[c.field];
    if (val === undefined || val === null) return { met: false, condition: c };

    let met = false;
    switch (c.operator) {
      case 'gt':      met = val > c.value; break;
      case 'lt':      met = val < c.value; break;
      case 'gte':     met = val >= c.value; break;
      case 'lte':     met = val <= c.value; break;
      case 'eq':      met = val === c.value; break;
      case 'between': met = val >= c.value && val <= c.value2; break;
      case 'in':      met = Array.isArray(c.value) && c.value.includes(val); break;
      default:        met = false;
    }
    return { met, condition: c };
  });

  const matched = results.filter(r => r.met).map(r => r.condition.description || r.condition.field);
  const missed = results.filter(r => !r.met).map(r => r.condition.description || r.condition.field);
  const totalWeight = conditions.reduce((s, c) => s + (c.weight || 1), 0);
  const metWeight = results.filter(r => r.met).reduce((s, r) => s + (r.condition.weight || 1), 0);
  const score = totalWeight > 0 ? metWeight / totalWeight : 0;

  const met = logic === 'and' ? missed.length === 0 : matched.length > 0;
  return { met, score, matched, missed };
}

/**
 * Build indicator snapshot for a symbol from raw market data.
 * Returns flat object with field names matching condition schema.
 *
 * @param {number[]} closes - closing prices (oldest first)
 * @param {number[]} highs - high prices
 * @param {number[]} lows - low prices
 * @param {object} ticker - { lastPr, change24h, usdtVolume, fundingRate }
 * @returns {object} indicator snapshot
 */
export function buildIndicatorSnapshot(closes, highs, lows, ticker = {}) {
  const snap = {};

  // Price
  snap.price = closes.length > 0 ? closes[closes.length - 1] : parseFloat(ticker.lastPr || 0);
  snap.change_24h = parseFloat(ticker.change24h || 0);
  snap.volume_24h = parseFloat(ticker.usdtVolume || 0);
  snap.funding_rate = parseFloat(ticker.fundingRate || 0);

  // Volume ratio (current vs 20-period avg)
  if (closes.length >= 20 && ticker.usdtVolume) {
    // Approximation: we don't have per-candle volume, use 24h vol vs avg
    snap.volume_ratio = 1; // placeholder — scanner provides real ratio
  }

  // RSI
  if (closes.length >= 15) {
    snap.rsi_14 = calcRSI(closes, 14);
  }

  // Bollinger Bands
  if (closes.length >= 20) {
    const bb = calcBollinger(closes, 20);
    snap.bb_upper = bb.upper;
    snap.bb_lower = bb.lower;
    snap.bb_middle = bb.middle;
    snap.bb_width = bb.upper && bb.lower ? (bb.upper - bb.lower) / bb.middle : 0;
    snap.bb_position = bb.upper && bb.lower ? (snap.price - bb.lower) / (bb.upper - bb.lower) : 0.5;
  }

  // Moving averages
  if (closes.length >= 20) {
    snap.ma_20 = closes.slice(-20).reduce((s, v) => s + v, 0) / 20;
  }
  if (closes.length >= 50) {
    snap.ma_50 = closes.slice(-50).reduce((s, v) => s + v, 0) / 50;
  }
  snap.trend = snap.ma_20 && snap.ma_50 ? (snap.ma_20 > snap.ma_50 ? 'bullish' : 'bearish') : 'unknown';

  // Support / Resistance (20-period)
  if (lows.length >= 20) snap.support_20 = Math.min(...lows.slice(-20));
  if (highs.length >= 20) snap.resistance_20 = Math.max(...highs.slice(-20));

  // Time
  snap.hour_utc = new Date().getUTCHours();

  return snap;
}
