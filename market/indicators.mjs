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
  const { closes, highs, lows, opens, volumes } = data;
  if (closes.length < 20) return { error: 'Insufficient data' };

  const price = closes[closes.length - 1];

  // --- Existing indicators ---
  const ema20 = calcEMA(closes, 20);
  const rsi7 = calcRSI(closes, 7);
  const rsi14 = calcRSI(closes, 14);
  const macd = calcMACD(closes);
  const atr = calcATR(highs, lows, closes, 14);
  const bb = calcBollinger(closes, 20);
  const support = Math.min(...lows.slice(-20));
  const resistance = Math.max(...highs.slice(-20));
  const swingLow = Math.min(...lows.slice(-50));
  const swingHigh = Math.max(...highs.slice(-50));
  const fib031_resistance = swingLow + (swingHigh - swingLow) * 0.31;
  const fib031_support = swingHigh - (swingHigh - swingLow) * 0.31;

  // --- Tier 1: Advanced indicators ---
  const fibonacci = calcFibonacciLevels(highs, lows, 50);
  const marketStructure = calcMarketStructure(highs, lows, closes, 5);
  const orderBlocks = opens ? calcOrderBlocks(opens, closes, highs, lows, volumes || []) : null;
  const fvg = calcFVG(highs, lows);
  const vwap = volumes ? calcVWAP(closes, volumes, highs, lows) : null;
  const obv = volumes ? calcOBV(closes, volumes) : null;

  // --- Tier 2: Extended indicators ---
  const ichimoku = calcIchimoku(highs, lows, closes);
  const pivots = calcPivotPoints(highs[highs.length - 1], lows[lows.length - 1], closes[closes.length - 1]);
  const maCross = calcMACrossover(closes);
  const adx = calcADX(highs, lows, closes, 14);

  return {
    timeframe,
    price,
    // Existing
    ema20,
    price_vs_ema20: price > ema20 ? 'above' : 'below',
    rsi7, rsi14,
    rsi_signal: rsi14 < 30 ? 'OVERSOLD' : rsi14 > 70 ? 'OVERBOUGHT' : rsi7 < 25 ? 'SHORT_TERM_OVERSOLD' : rsi7 > 75 ? 'SHORT_TERM_OVERBOUGHT' : 'NEUTRAL',
    macd_line: macd.macd, macd_signal: macd.signal, macd_histogram: macd.histogram,
    macd_cross: macd.histogram > 0 && macd.prevHistogram <= 0 ? 'BULLISH_CROSS' : macd.histogram < 0 && macd.prevHistogram >= 0 ? 'BEARISH_CROSS' : 'NONE',
    atr, atr_pct: ((atr / price) * 100).toFixed(2) + '%',
    bollinger: bb,
    bb_position: bb ? (price > bb.upper ? 'ABOVE_UPPER' : price < bb.lower ? 'BELOW_LOWER' : 'IN_BAND') : null,
    support, resistance,
    fib_031: { from_bottom: +fib031_resistance.toFixed(2), from_top: +fib031_support.toFixed(2) },
    // Tier 1
    fibonacci,
    market_structure: marketStructure,
    order_blocks: orderBlocks,
    fvg,
    vwap,
    obv,
    // Tier 2
    ichimoku,
    pivots,
    ma_cross: maCross,
    adx,
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

// =====================================================================
//  TIER 1: Fibonacci, Market Structure, Order Blocks, FVG, VWAP, OBV, OI
// =====================================================================

/** Full Fibonacci retracement levels from swing high/low. */
export function calcFibonacciLevels(highs, lows, lookback = 50) {
  const h = highs.slice(-lookback);
  const l = lows.slice(-lookback);
  const swingHigh = Math.max(...h);
  const swingLow = Math.min(...l);
  const range = swingHigh - swingLow;
  if (range <= 0) return null;
  const highIdx = h.lastIndexOf(swingHigh);
  const lowIdx = l.lastIndexOf(swingLow);
  // Determine trend: if swing low came before swing high → uptrend (retrace from top)
  const uptrend = lowIdx < highIdx;
  const r = (ratio) => +(uptrend
    ? swingHigh - range * ratio   // retracement from top
    : swingLow + range * ratio    // retracement from bottom
  ).toFixed(2);
  return {
    levels: { 0.236: r(0.236), 0.382: r(0.382), 0.5: r(0.5), 0.618: r(0.618), 0.786: r(0.786) },
    swingHigh: +swingHigh.toFixed(2),
    swingLow: +swingLow.toFixed(2),
    trend: uptrend ? 'uptrend' : 'downtrend',
  };
}

/** Market structure: swing points, HH/HL/LH/LL, Break of Structure. */
export function calcMarketStructure(highs, lows, closes, lookback = 5) {
  const swingHighs = [];
  const swingLows = [];
  for (let i = lookback; i < highs.length - lookback; i++) {
    const leftHighs = highs.slice(i - lookback, i);
    const rightHighs = highs.slice(i + 1, i + lookback + 1);
    if (highs[i] >= Math.max(...leftHighs) && highs[i] >= Math.max(...rightHighs)) {
      swingHighs.push({ index: i, price: highs[i] });
    }
    const leftLows = lows.slice(i - lookback, i);
    const rightLows = lows.slice(i + 1, i + lookback + 1);
    if (lows[i] <= Math.min(...leftLows) && lows[i] <= Math.min(...rightLows)) {
      swingLows.push({ index: i, price: lows[i] });
    }
  }
  // Higher highs / lower lows
  const recentSH = swingHighs.slice(-3);
  const recentSL = swingLows.slice(-3);
  const higherHighs = recentSH.length >= 2 && recentSH[recentSH.length - 1].price > recentSH[recentSH.length - 2].price;
  const lowerLows = recentSL.length >= 2 && recentSL[recentSL.length - 1].price < recentSL[recentSL.length - 2].price;
  const higherLows = recentSL.length >= 2 && recentSL[recentSL.length - 1].price > recentSL[recentSL.length - 2].price;
  const lowerHighs = recentSH.length >= 2 && recentSH[recentSH.length - 1].price < recentSH[recentSH.length - 2].price;
  // Break of Structure
  let lastBOS = null;
  const price = closes[closes.length - 1];
  if (recentSH.length >= 1 && price > recentSH[recentSH.length - 1].price) {
    lastBOS = { type: 'bullish', price: recentSH[recentSH.length - 1].price };
  } else if (recentSL.length >= 1 && price < recentSL[recentSL.length - 1].price) {
    lastBOS = { type: 'bearish', price: recentSL[recentSL.length - 1].price };
  }
  const trend = higherHighs && higherLows ? 'bullish' : lowerLows && lowerHighs ? 'bearish' : 'ranging';
  return { trend, higherHighs, lowerLows, higherLows, lowerHighs, lastBOS, swingHighs: recentSH.map(s => +s.price.toFixed(2)), swingLows: recentSL.map(s => +s.price.toFixed(2)) };
}

/** ICT Order Blocks: last bullish/bearish engulfing candles before impulsive move. */
export function calcOrderBlocks(opens, closes, highs, lows, volumes) {
  const bullishOBs = [];
  const bearishOBs = [];
  const len = opens.length;
  for (let i = 2; i < len - 1; i++) {
    // Bullish OB: bearish candle followed by strong bullish move
    if (closes[i] < opens[i] && closes[i + 1] > opens[i + 1]) {
      const moveSize = (closes[i + 1] - opens[i + 1]) / opens[i + 1];
      if (moveSize > 0.003) { // >0.3% impulsive move
        bullishOBs.push({ top: +Math.max(opens[i], closes[i]).toFixed(2), bottom: +lows[i].toFixed(2), strength: +(moveSize * 100).toFixed(1) });
      }
    }
    // Bearish OB: bullish candle followed by strong bearish move
    if (closes[i] > opens[i] && closes[i + 1] < opens[i + 1]) {
      const moveSize = (opens[i + 1] - closes[i + 1]) / opens[i + 1];
      if (moveSize > 0.003) {
        bearishOBs.push({ top: +highs[i].toFixed(2), bottom: +Math.min(opens[i], closes[i]).toFixed(2), strength: +(moveSize * 100).toFixed(1) });
      }
    }
  }
  return { bullish: bullishOBs.slice(-3), bearish: bearishOBs.slice(-3) };
}

/** ICT Fair Value Gaps: 3-candle imbalance zones. */
export function calcFVG(highs, lows) {
  const bullishFVGs = [];
  const bearishFVGs = [];
  for (let i = 2; i < highs.length; i++) {
    // Bullish FVG: candle 3 low > candle 1 high (gap up)
    if (lows[i] > highs[i - 2]) {
      bullishFVGs.push({ top: +lows[i].toFixed(2), bottom: +highs[i - 2].toFixed(2) });
    }
    // Bearish FVG: candle 3 high < candle 1 low (gap down)
    if (highs[i] < lows[i - 2]) {
      bearishFVGs.push({ top: +lows[i - 2].toFixed(2), bottom: +highs[i].toFixed(2) });
    }
  }
  return { bullish: bullishFVGs.slice(-3), bearish: bearishFVGs.slice(-3) };
}

/** Volume Weighted Average Price. */
export function calcVWAP(closes, volumes, highs, lows) {
  if (!volumes?.length || volumes.length < 2) return null;
  let cumTPV = 0, cumVol = 0;
  for (let i = 0; i < closes.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    cumTPV += tp * (volumes[i] || 1);
    cumVol += volumes[i] || 1;
  }
  return cumVol > 0 ? +(cumTPV / cumVol).toFixed(2) : null;
}

/** On-Balance Volume with trend and divergence detection. */
export function calcOBV(closes, volumes) {
  if (!volumes?.length || closes.length < 10) return { obv: 0, obvTrend: 'flat', divergence: 'none' };
  let obv = 0;
  const obvArr = [0];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) obv += volumes[i] || 0;
    else if (closes[i] < closes[i - 1]) obv -= volumes[i] || 0;
    obvArr.push(obv);
  }
  const recent = obvArr.slice(-10);
  const obvEma = recent.reduce((s, v) => s + v, 0) / recent.length;
  const obvTrend = obv > obvEma * 1.05 ? 'rising' : obv < obvEma * 0.95 ? 'falling' : 'flat';
  // Divergence: price making new highs but OBV isn't (bearish), or price making new lows but OBV isn't (bullish)
  const priceUp = closes[closes.length - 1] > closes[closes.length - 6];
  const obvUp = obvArr[obvArr.length - 1] > obvArr[obvArr.length - 6];
  let divergence = 'none';
  if (priceUp && !obvUp) divergence = 'bearish';
  if (!priceUp && obvUp) divergence = 'bullish';
  return { obv: Math.round(obv), obvTrend, divergence };
}

/** Open Interest analysis: divergence, crowding, squeeze signals. */
export function calcOIAnalysis(currentOI, prevOI, fundingRate, priceChange) {
  if (!currentOI || !prevOI) return null;
  const changePct = ((currentOI - prevOI) / prevOI) * 100;
  // Divergence
  let divergence = 'none';
  if (priceChange > 0 && changePct < -2) divergence = 'bearish';    // price up, OI down = weak rally
  if (priceChange < 0 && changePct > 2) divergence = 'bullish';     // price down, OI up = accumulation
  if (priceChange > 0 && changePct > 5) divergence = 'strong_bull'; // price up, OI up = strong trend
  // Crowding
  let crowding = 'neutral';
  if (fundingRate > 0.03) crowding = 'longs_crowded';
  if (fundingRate < -0.01) crowding = 'shorts_crowded';
  // Signal
  let signal = 'none';
  if (crowding === 'longs_crowded' && priceChange < 0) signal = 'long_squeeze';
  if (crowding === 'shorts_crowded' && priceChange > 0) signal = 'short_squeeze';
  if (changePct > 5 && priceChange > 0) signal = 'accumulation';
  if (changePct > 5 && priceChange < 0) signal = 'distribution';
  return { current: currentOI, changePct: +changePct.toFixed(2), divergence, crowding, signal };
}

// =====================================================================
//  TIER 2: Ichimoku, Pivots, MA Crossovers, ADX
// =====================================================================

/** Ichimoku Cloud (9/26/52 periods). */
export function calcIchimoku(highs, lows, closes) {
  if (closes.length < 52) return null;
  const midHL = (h, l, p) => {
    const s = h.slice(-p);
    const sl = l.slice(-p);
    return (Math.max(...s) + Math.min(...sl)) / 2;
  };
  const tenkan = +midHL(highs, lows, 9).toFixed(2);    // Conversion Line
  const kijun = +midHL(highs, lows, 26).toFixed(2);     // Base Line
  const senkouA = +((tenkan + kijun) / 2).toFixed(2);   // Leading Span A (current bar value, not forward-displaced)
  const senkouB = +midHL(highs, lows, 52).toFixed(2);   // Leading Span B (current bar value)
  const chikouVal = closes.length >= 27 ? closes[closes.length - 27] : closes[closes.length - 1];
  const chikou = +chikouVal.toFixed(2); // Lagging Span
  const price = closes[closes.length - 1];
  const cloudTop = Math.max(senkouA, senkouB);
  const cloudBottom = Math.min(senkouA, senkouB);
  let cloudSignal = 'neutral';
  if (price > cloudTop && tenkan > kijun) cloudSignal = 'bullish';
  if (price < cloudBottom && tenkan < kijun) cloudSignal = 'bearish';
  return { tenkan, kijun, senkouA, senkouB, chikou, cloudTop: +cloudTop.toFixed(2), cloudBottom: +cloudBottom.toFixed(2), cloudSignal };
}

/** Standard Pivot Points from daily OHLC. */
export function calcPivotPoints(high, low, close) {
  const pivot = +(( high + low + close) / 3).toFixed(2);
  return {
    pivot,
    r1: +(2 * pivot - low).toFixed(2),
    r2: +(pivot + (high - low)).toFixed(2),
    r3: +(high + 2 * (pivot - low)).toFixed(2),
    s1: +(2 * pivot - high).toFixed(2),
    s2: +(pivot - (high - low)).toFixed(2),
    s3: +(low - 2 * (high - pivot)).toFixed(2),
  };
}

/** Multiple MA crossovers: EMA9/21 + SMA50/200. */
export function calcMACrossover(closes) {
  if (closes.length < 200) {
    // Fallback: only short MAs
    const ema9 = calcEMA(closes, 9);
    const ema21 = calcEMA(closes, 21);
    const prevEma9 = closes.length > 10 ? calcEMA(closes.slice(0, -1), 9) : null;
    const prevEma21 = closes.length > 22 ? calcEMA(closes.slice(0, -1), 21) : null;
    let shortCross = 'none';
    if (ema9 && ema21 && prevEma9 && prevEma21) {
      if (ema9 > ema21 && prevEma9 <= prevEma21) shortCross = 'golden';
      if (ema9 < ema21 && prevEma9 >= prevEma21) shortCross = 'dead';
    }
    return { ema9, ema21, sma50: null, sma200: null, shortCross, longCross: 'none' };
  }
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const sma50 = +(closes.slice(-50).reduce((s, v) => s + v, 0) / 50).toFixed(2);
  const sma200 = +(closes.slice(-200).reduce((s, v) => s + v, 0) / 200).toFixed(2);
  const prevEma9 = calcEMA(closes.slice(0, -1), 9);
  const prevEma21 = calcEMA(closes.slice(0, -1), 21);
  const prevSma50 = +(closes.slice(-51, -1).reduce((s, v) => s + v, 0) / 50).toFixed(2);
  const prevSma200 = +(closes.slice(-201, -1).reduce((s, v) => s + v, 0) / 200).toFixed(2);
  let shortCross = 'none';
  if (ema9 > ema21 && prevEma9 <= prevEma21) shortCross = 'golden';
  if (ema9 < ema21 && prevEma9 >= prevEma21) shortCross = 'dead';
  let longCross = 'none';
  if (sma50 > sma200 && prevSma50 <= prevSma200) longCross = 'golden';
  if (sma50 < sma200 && prevSma50 >= prevSma200) longCross = 'dead';
  return { ema9, ema21, sma50, sma200, shortCross, longCross };
}

/** Average Directional Index — trend strength. */
export function calcADX(highs, lows, closes, period = 14) {
  if (highs.length < period * 2 + 1) return null;
  const plusDMs = [], minusDMs = [], trs = [];
  for (let i = 1; i < highs.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  // Wilder's smoothing
  const smooth = (arr, p) => {
    let sum = arr.slice(0, p).reduce((s, v) => s + v, 0);
    const result = [sum];
    for (let i = p; i < arr.length; i++) {
      sum = sum - sum / p + arr[i];
      result.push(sum);
    }
    return result;
  };
  const smoothTR = smooth(trs, period);
  const smoothPlusDM = smooth(plusDMs, period);
  const smoothMinusDM = smooth(minusDMs, period);
  const dxArr = [];
  for (let i = 0; i < smoothTR.length; i++) {
    if (smoothTR[i] === 0) { dxArr.push(0); continue; }
    const plusDI = (smoothPlusDM[i] / smoothTR[i]) * 100;
    const minusDI = (smoothMinusDM[i] / smoothTR[i]) * 100;
    const sum = plusDI + minusDI;
    dxArr.push(sum === 0 ? 0 : Math.abs(plusDI - minusDI) / sum * 100);
  }
  if (dxArr.length < period) return null;
  let adx = dxArr.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < dxArr.length; i++) {
    adx = (adx * (period - 1) + dxArr[i]) / period;
  }
  const lastTR = smoothTR[smoothTR.length - 1] || 1;
  const plusDI = +((smoothPlusDM[smoothPlusDM.length - 1] / lastTR) * 100).toFixed(1);
  const minusDI = +((smoothMinusDM[smoothMinusDM.length - 1] / lastTR) * 100).toFixed(1);
  return { adx: +adx.toFixed(1), plusDI, minusDI, trending: adx >= 25 };
}
