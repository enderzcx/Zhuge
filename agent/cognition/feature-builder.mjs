import { buildIndicatorSnapshot } from './conditions.mjs';
import { calcATR } from '../../market/indicators.mjs';

export const TIMEFRAME_MINUTES = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1H': 60,
  '4H': 240,
  '1D': 1440,
};

function toTs(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return value;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function avg(values) {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

function std(values) {
  if (values.length < 2) return 0;
  const mean = avg(values);
  const variance = values.reduce((s, v) => s + ((v - mean) ** 2), 0) / values.length;
  return Math.sqrt(variance);
}

function zscore(current, values) {
  const series = values.filter((v) => Number.isFinite(v));
  if (!Number.isFinite(current) || series.length < 5) return 0;
  const sigma = std(series);
  if (!sigma) return 0;
  return (current - avg(series)) / sigma;
}

function percentileRank(value, values) {
  const series = values.filter((v) => Number.isFinite(v));
  if (!Number.isFinite(value) || !series.length) return 0;
  const below = series.filter((v) => v <= value).length;
  return below / series.length;
}

function computeRegime(trend, structureTrend) {
  if (trend === 'bullish' && structureTrend === 'bullish') return 'bullish';
  if (trend === 'bearish' && structureTrend === 'bearish') return 'bearish';
  return 'mixed';
}

function computeBarsInCurrentRegime(closes, highs, lows) {
  const history = [];
  for (let i = 20; i <= closes.length; i++) {
    const snap = buildIndicatorSnapshot(
      closes.slice(0, i),
      highs.slice(0, i),
      lows.slice(0, i),
      { lastPr: closes[i - 1], change24h: 0, fundingRate: 0, usdtVolume: 0 }
    );
    history.push(computeRegime(snap.trend, snap.market_structure_trend));
  }
  const current = history[history.length - 1] || 'mixed';
  let bars = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i] !== current) break;
    bars++;
  }
  return { regime: current, bars, history };
}

function computeBarsSinceEvent(closes, highs, lows, eventType) {
  if (closes.length < 25) return null;
  for (let i = closes.length; i >= 20; i--) {
    const snap = buildIndicatorSnapshot(
      closes.slice(0, i),
      highs.slice(0, i),
      lows.slice(0, i),
      { lastPr: closes[i - 1], change24h: 0, fundingRate: 0, usdtVolume: 0 }
    );
    if (snap.bos_type === eventType) {
      return closes.length - i;
    }
  }
  return null;
}

function computeDaysRelativeToMA(closes, period, comparator) {
  if (closes.length < period + 1) return 0;
  let bars = 0;
  for (let i = closes.length; i >= period; i--) {
    const slice = closes.slice(i - period, i);
    const ma = avg(slice);
    const price = closes[i - 1];
    const ok = comparator === 'above' ? price >= ma : price <= ma;
    if (!ok) break;
    bars++;
  }
  return bars;
}

function computeOverheadSupplyScore(closes, volumes, marketStates, lookbackBars) {
  if (closes.length < 10) return 0;
  const prices = closes.slice(-lookbackBars);
  const vols = volumes.slice(-lookbackBars);
  if (!prices.length) return 0;
  const current = prices[prices.length - 1];
  const high = Math.max(...prices);
  if (high <= current) return 0;
  const range = high - current;
  const bucketSize = range / 20 || 1;
  let score = 0;
  let maxScore = 0;
  for (let i = 0; i < prices.length; i++) {
    const price = prices[i];
    if (price <= current) continue;
    const volume = vols[i] || avg(vols) || 1;
    const ms = marketStates?.[i] || {};
    const oiMultiplier = 1 + Math.max(0, Number(ms.oi_change_24h || 0)) / 100;
    const fundingMultiplier = 1 + Math.max(0, Number(ms.funding_rate || 0)) * 10;
    const recencyWeight = 0.4 + 0.6 * ((i + 1) / prices.length);
    const weight = volume * oiMultiplier * fundingMultiplier * recencyWeight;
    maxScore += weight;
    if (price >= current + bucketSize) score += weight;
  }
  if (!maxScore) return 0;
  return Math.max(0, Math.min(100, (score / maxScore) * 100));
}

export function buildFeatureSnapshot({ candles, marketStates = [], timeframe = '1H', ticker = {} } = {}) {
  const rows = candles || [];
  const opens = rows.map((c) => Number(c.open ?? c.o ?? 0));
  const highs = rows.map((c) => Number(c.high ?? c.h ?? 0));
  const lows = rows.map((c) => Number(c.low ?? c.l ?? 0));
  const closes = rows.map((c) => Number(c.close ?? c.c ?? 0));
  const volumes = rows.map((c) => Number(c.volume ?? c.v ?? 0));

  const currentTicker = {
    lastPr: closes[closes.length - 1] || ticker.lastPr || 0,
    change24h: ticker.change24h || 0,
    fundingRate: ticker.fundingRate || marketStates[marketStates.length - 1]?.funding_rate || 0,
    usdtVolume: ticker.usdtVolume || volumes[volumes.length - 1] || 0,
  };

  const snap = buildIndicatorSnapshot(closes, highs, lows, currentTicker);
  const atr = calcATR(highs, lows, closes, 14);
  const tfMinutes = TIMEFRAME_MINUTES[timeframe] || 60;
  const { regime, bars, history } = computeBarsInCurrentRegime(closes, highs, lows);
  const breakoutBars = computeBarsSinceEvent(closes, highs, lows, 'bullish');
  const breakdownBars = computeBarsSinceEvent(closes, highs, lows, 'bearish');
  const barsAboveMA20 = computeDaysRelativeToMA(closes, 20, 'above');
  const barsBelowMA20 = computeDaysRelativeToMA(closes, 20, 'below');
  const ath = closes.length ? Math.max(...closes) : 0;
  const currentPrice = closes[closes.length - 1] || 0;
  const ranges = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1]) ranges.push(Math.abs(closes[i] - closes[i - 1]) / closes[i - 1]);
  }

  const stateSeries = marketStates.slice(-Math.min(30, marketStates.length));
  const fundingSeries = stateSeries.map((s) => Number(s.funding_rate || 0));
  const oiSeries = stateSeries.map((s) => Number(s.open_interest || 0));
  const latestState = marketStates[marketStates.length - 1] || {};
  const latestOpenInterest = Number(latestState.open_interest || 0);
  const latestFunding = Number(latestState.funding_rate || 0);

  snap.regime = regime;
  snap.bars_in_regime = bars;
  snap.days_in_regime = Number(((bars * tfMinutes) / 1440).toFixed(2));
  snap.bars_since_regime_change = Math.max(0, bars - 1);
  snap.bars_since_breakout = breakoutBars ?? 9999;
  snap.bars_since_breakdown = breakdownBars ?? 9999;
  snap.days_above_ma_20 = Number(((barsAboveMA20 * tfMinutes) / 1440).toFixed(2));
  snap.days_below_ma_20 = Number(((barsBelowMA20 * tfMinutes) / 1440).toFixed(2));
  snap.distance_to_ath_pct = ath > 0 ? Number((((currentPrice - ath) / ath) * 100).toFixed(2)) : 0;
  snap.range_percentile_180d = Number((percentileRank(ranges[ranges.length - 1] || 0, ranges.slice(-180)) * 100).toFixed(2));
  snap.atr = atr || 0;
  snap.atr_pct = currentPrice > 0 && atr ? Number((atr / currentPrice).toFixed(4)) : 0;
  snap.oi_zscore_30d = Number(zscore(latestOpenInterest, oiSeries).toFixed(2));
  snap.funding_zscore_30d = Number(zscore(latestFunding, fundingSeries).toFixed(2));
  snap.overhead_supply_score_90d = Number(computeOverheadSupplyScore(closes, volumes, marketStates, Math.min(closes.length, 90)).toFixed(2));
  snap.overhead_supply_score_365d = Number(computeOverheadSupplyScore(closes, volumes, marketStates, Math.min(closes.length, 365)).toFixed(2));
  snap.open_interest = latestOpenInterest || 0;
  snap.oi_change_24h = Number(latestState.oi_change_24h || 0);
  snap.mark_price = Number(latestState.mark_price || currentPrice || 0);
  snap.index_price = Number(latestState.index_price || currentPrice || 0);
  snap.basis_bps = Number(latestState.basis_bps || 0);
  snap.market_state_source = latestState.source || 'computed';
  snap.regime_history = history;
  snap.candle_ts = toTs(rows[rows.length - 1]?.ts ?? rows[rows.length - 1]?.ts_start);
  return snap;
}
