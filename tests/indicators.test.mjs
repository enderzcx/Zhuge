import { describe, it, expect } from 'vitest';
import { parseCandles, calcEMA, calcEMAArray, calcRSI, calcATR, calcMACD, calcBollinger, computeIndicators } from '../market/indicators.mjs';

// --- parseCandles ---
describe('parseCandles', () => {
  it('returns empty arrays for null/empty input', () => {
    expect(parseCandles(null)).toEqual({ closes: [], highs: [], lows: [], opens: [], volumes: [] });
    expect(parseCandles([])).toEqual({ closes: [], highs: [], lows: [], opens: [], volumes: [] });
  });

  it('parses Bitget candle format correctly', () => {
    // Bitget: [ts, open, high, low, close, vol, quoteVol] — newest first
    const raw = [
      ['1700002', '102', '105', '100', '103', '500', '50000'],
      ['1700001', '100', '104', '99', '101', '400', '40000'],
    ];
    const result = parseCandles(raw);
    // Reversed to oldest first
    expect(result.closes).toEqual([101, 103]);
    expect(result.opens).toEqual([100, 102]);
    expect(result.highs).toEqual([104, 105]);
    expect(result.lows).toEqual([99, 100]);
    expect(result.volumes).toEqual([400, 500]);
  });
});

// --- calcEMA ---
describe('calcEMA', () => {
  it('returns null when data is shorter than period', () => {
    expect(calcEMA([1, 2, 3], 5)).toBeNull();
    expect(calcEMA([], 1)).toBeNull();
  });

  it('returns SMA for data exactly equal to period length', () => {
    const data = [10, 20, 30];
    expect(calcEMA(data, 3)).toBe(20); // SMA of [10,20,30] = 20
  });

  it('computes correct EMA for known series', () => {
    // Period 3, k = 2/4 = 0.5
    // SMA(10,20,30) = 20
    // EMA[3] = 40*0.5 + 20*0.5 = 30
    const data = [10, 20, 30, 40];
    expect(calcEMA(data, 3)).toBe(30);
  });
});

// --- calcEMAArray ---
describe('calcEMAArray', () => {
  it('returns null for insufficient data', () => {
    expect(calcEMAArray([1], 5)).toBeNull();
  });

  it('returns array of correct length', () => {
    const data = [10, 20, 30, 40, 50];
    const result = calcEMAArray(data, 3);
    expect(result).toHaveLength(5);
  });
});

// --- calcRSI ---
describe('calcRSI', () => {
  it('returns 50 for insufficient data', () => {
    expect(calcRSI([100], 14)).toBe(50);
    expect(calcRSI([100, 101], 14)).toBe(50);
  });

  it('returns 100 for all-gain series', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(calcRSI(closes, 14)).toBe(100);
  });

  it('returns near-zero for all-loss series', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 200 - i);
    const rsi = calcRSI(closes, 14);
    expect(rsi).toBeLessThan(5);
    expect(rsi).toBeGreaterThanOrEqual(0);
  });

  it('returns ~50 for alternating up/down of equal magnitude', () => {
    const closes = [];
    for (let i = 0; i < 30; i++) closes.push(100 + (i % 2 === 0 ? 1 : -1));
    const rsi = calcRSI(closes, 14);
    expect(rsi).toBeGreaterThan(40);
    expect(rsi).toBeLessThan(60);
  });

  it('uses default period 14', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(calcRSI(closes)).toBe(100); // all gains
  });
});

// --- calcATR ---
describe('calcATR', () => {
  it('returns null for insufficient data', () => {
    expect(calcATR([1], [1], [1], 14)).toBeNull();
  });

  it('returns 0 for constant prices', () => {
    const n = 20;
    const same = Array(n).fill(100);
    expect(calcATR(same, same, same, 14)).toBe(0);
  });

  it('correctly measures range for known data', () => {
    const highs = Array.from({ length: 20 }, () => 110);
    const lows = Array.from({ length: 20 }, () => 90);
    const closes = Array.from({ length: 20 }, () => 100);
    const atr = calcATR(highs, lows, closes, 14);
    expect(atr).toBe(20); // H-L = 20 every bar, no gaps
  });
});

// --- calcMACD ---
describe('calcMACD', () => {
  it('returns zeros for insufficient data', () => {
    const result = calcMACD(Array(10).fill(100));
    expect(result).toEqual({ macd: 0, signal: 0, histogram: 0, prevHistogram: 0 });
  });

  it('returns zeros for exactly 26 bars (need 26+9 for signal)', () => {
    const result = calcMACD(Array(26).fill(100));
    expect(result).toEqual({ macd: 0, signal: 0, histogram: 0, prevHistogram: 0 });
  });

  it('returns non-zero for trending series with enough data', () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + i * 0.5);
    const result = calcMACD(closes);
    expect(result.macd).toBeGreaterThan(0); // uptrend → positive MACD
    expect(result.histogram).toBeDefined();
  });

  it('returns negative MACD for downtrend', () => {
    const closes = Array.from({ length: 50 }, (_, i) => 200 - i * 0.5);
    const result = calcMACD(closes);
    expect(result.macd).toBeLessThan(0);
  });
});

// --- calcBollinger ---
describe('calcBollinger', () => {
  it('returns null for insufficient data', () => {
    expect(calcBollinger(Array(5).fill(100), 20)).toBeNull();
  });

  it('bands collapse for constant price', () => {
    const result = calcBollinger(Array(20).fill(100), 20);
    expect(result.upper).toBe(100);
    expect(result.middle).toBe(100);
    expect(result.lower).toBe(100);
  });

  it('upper > middle > lower for volatile data', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + Math.sin(i) * 10);
    const result = calcBollinger(closes, 20);
    expect(result.upper).toBeGreaterThan(result.middle);
    expect(result.middle).toBeGreaterThan(result.lower);
  });

  it('bands are symmetric around middle', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + (i % 2 === 0 ? 5 : -5));
    const result = calcBollinger(closes, 20);
    const upperDist = result.upper - result.middle;
    const lowerDist = result.middle - result.lower;
    expect(upperDist).toBeCloseTo(lowerDist, 10);
  });
});

// --- computeIndicators ---
describe('computeIndicators', () => {
  it('returns error for insufficient data', () => {
    const data = { closes: [100], highs: [101], lows: [99] };
    expect(computeIndicators(data, '1H')).toEqual({ error: 'Insufficient data' });
  });

  it('returns full indicator set for 50 bars', () => {
    const n = 50;
    const closes = Array.from({ length: n }, (_, i) => 100 + Math.sin(i * 0.2) * 5);
    const highs = closes.map(c => c + 2);
    const lows = closes.map(c => c - 2);
    const result = computeIndicators({ closes, highs, lows }, '1H');
    expect(result.error).toBeUndefined();
    expect(result.price).toBeDefined();
    expect(result.ema20).toBeDefined();
    expect(result.rsi14).toBeDefined();
    expect(result.macd_line).toBeDefined();
    expect(result.atr).toBeDefined();
    expect(result.bollinger).toBeDefined();
    expect(result.fib_031).toBeDefined();
  });
});
