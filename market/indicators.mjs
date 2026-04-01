/**
 * Pure math functions for technical indicator computation.
 * No external dependencies.
 */

export function parseCandles(raw) {
  if (!raw?.length) return { closes: [], highs: [], lows: [], opens: [], volumes: [] };
  // Bitget candle format: [ts, open, high, low, close, vol, quoteVol]
  const sorted = [...raw].reverse(); // oldest first
  return {
    closes: sorted.map(k => parseFloat(k[4])),
    highs: sorted.map(k => parseFloat(k[2])),
    lows: sorted.map(k => parseFloat(k[3])),
    opens: sorted.map(k => parseFloat(k[1])),
    volumes: sorted.map(k => parseFloat(k[5])),
  };
}

export function computeIndicators(data, timeframe) {
  const { closes, highs, lows } = data;
  if (closes.length < 20) return { error: 'Insufficient data' };

  const price = closes[closes.length - 1];

  // EMA20
  const ema20 = calcEMA(closes, 20);
  // RSI (7 short-term + 14 standard)
  const rsi7 = calcRSI(closes, 7);
  const rsi14 = calcRSI(closes, 14);
  // MACD (12, 26, 9)
  const macd = calcMACD(closes);
  // ATR (14)
  const atr = calcATR(highs, lows, closes, 14);
  // Bollinger Bands
  const bb = calcBollinger(closes, 20);
  // Support & Resistance (20-bar)
  const support = Math.min(...lows.slice(-20));
  const resistance = Math.max(...highs.slice(-20));
  // Fibonacci 0.31 level (from recent swing low to high)
  const swingLow = Math.min(...lows.slice(-50));
  const swingHigh = Math.max(...highs.slice(-50));
  const fib031_resistance = swingLow + (swingHigh - swingLow) * 0.31; // from bottom
  const fib031_support = swingHigh - (swingHigh - swingLow) * 0.31;   // from top

  return {
    timeframe,
    price,
    ema20,
    price_vs_ema20: price > ema20 ? 'above' : 'below',
    rsi7,
    rsi14,
    rsi_signal: rsi14 < 30 ? 'OVERSOLD' : rsi14 > 70 ? 'OVERBOUGHT' : rsi7 < 25 ? 'SHORT_TERM_OVERSOLD' : rsi7 > 75 ? 'SHORT_TERM_OVERBOUGHT' : 'NEUTRAL',
    macd_line: macd.macd,
    macd_signal: macd.signal,
    macd_histogram: macd.histogram,
    macd_cross: macd.histogram > 0 && macd.prevHistogram <= 0 ? 'BULLISH_CROSS' : macd.histogram < 0 && macd.prevHistogram >= 0 ? 'BEARISH_CROSS' : 'NONE',
    atr,
    atr_pct: ((atr / price) * 100).toFixed(2) + '%',
    bollinger: bb,
    bb_position: bb ? (price > bb.upper ? 'ABOVE_UPPER' : price < bb.lower ? 'BELOW_LOWER' : 'IN_BAND') : null,
    support,
    resistance,
    fib_031: {
      from_bottom: +fib031_resistance.toFixed(2),
      from_top: +fib031_support.toFixed(2),
      note: 'The 0.31 Fibonacci level is a high-precision support/resistance. Price touching 0.31 from below = strong resistance (expect pullback). Price touching 0.31 from above = strong support (expect bounce).',
    },
  };
}

export function calcEMA(data, period) {
  if (data.length < period) return null;
  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return +ema.toFixed(2);
}

export function calcEMAArray(data, period) {
  if (data.length < period) return null;
  const k = 2 / (period + 1);
  const result = [];
  let ema = data.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = 0; i < data.length; i++) {
    if (i < period) { result.push(ema); continue; }
    ema = data[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

export function calcMACD(closes) {
  const ema12 = calcEMAArray(closes, 12);
  const ema26 = calcEMAArray(closes, 26);
  if (!ema12 || !ema26) return { macd: 0, signal: 0, histogram: 0, prevHistogram: 0 };
  // Only use MACD values from index 26+ where EMA26 is meaningful
  const macdLine = ema12.slice(26).map((v, i) => v - ema26[i + 26]);
  if (macdLine.length < 9) return { macd: 0, signal: 0, histogram: 0, prevHistogram: 0 };
  const signalLine = calcEMAArray(macdLine, 9);
  if (!signalLine) return { macd: 0, signal: 0, histogram: 0, prevHistogram: 0 };
  const last = macdLine.length - 1;
  return {
    macd: +macdLine[last].toFixed(2),
    signal: +signalLine[last].toFixed(2),
    histogram: +(macdLine[last] - signalLine[last]).toFixed(2),
    prevHistogram: last > 0 ? +(macdLine[last - 1] - signalLine[last - 1]).toFixed(2) : 0,
  };
}

export function calcATR(highs, lows, closes, period = 14) {
  if (highs.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return +atr.toFixed(2);
}

export function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  // Seed with SMA over first `period` bars
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  // Wilder's smoothing for remaining bars
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return +(100 - 100 / (1 + rs)).toFixed(2);
}

export function calcBollinger(closes, period = 20) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const ma = slice.reduce((s, v) => s + v, 0) / period;
  const stddev = Math.sqrt(slice.reduce((s, v) => s + (v - ma) ** 2, 0) / period);
  return { upper: ma + 2 * stddev, middle: ma, lower: ma - 2 * stddev };
}
