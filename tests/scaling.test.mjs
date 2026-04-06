import { describe, it, expect } from 'vitest';

// We can't easily import from executor.mjs (needs full dep tree).
// Instead, extract the pure math and test directly.

// --- Pure math extracted from bitget/executor.mjs ---

function calcWeightedAvgEntry(existingAvg, existingSize, newPrice, newSize) {
  const totalSize = existingSize + newSize;
  if (totalSize === 0) return newPrice;
  return (existingAvg * existingSize + newPrice * newSize) / totalSize;
}

function calcStopLoss(side, avgEntry, level, stopLossPcts = [3.0, 2.5, 2.0, 1.5]) {
  const pct = stopLossPcts[level] / 100;
  return side === 'long'
    ? parseFloat((avgEntry * (1 - pct)).toFixed(2))
    : parseFloat((avgEntry * (1 + pct)).toFixed(2));
}

function calcLevelSize(level, maxKellySize, ratios = [1, 1, 2, 4]) {
  const totalRatio = ratios.reduce((s, r) => s + r, 0);
  return parseFloat((ratios[level] / totalRatio * maxKellySize).toFixed(4));
}

// Kelly pure math: f = (p*b - q) / b, half-kelly capped at 25%
function kellyFraction(wins, losses) {
  const total = wins.length + losses.length;
  if (total < 5) return 0;
  if (wins.length === 0) return 0;
  const avgWin = wins.reduce((s, v) => s + v, 0) / wins.length;
  const avgLoss = losses.length > 0 ? losses.reduce((s, v) => s + Math.abs(v), 0) / losses.length : 0;
  if (avgLoss === 0) return 0;
  const p = wins.length / total;
  const q = 1 - p;
  const b = avgWin / avgLoss;
  const kelly = (p * b - q) / b;
  if (kelly <= 0) return 0;
  const halfKelly = kelly * 0.5;
  return Math.min(halfKelly, 0.25);
}

function kellyToContractSize(fraction, available, leverage, price) {
  if (price <= 0) return 0;
  const margin = fraction * available;
  return Math.max(parseFloat((margin * leverage / price).toFixed(4)), 0.01);
}

// --- Tests ---

describe('calcWeightedAvgEntry', () => {
  it('returns newPrice when totalSize is 0', () => {
    expect(calcWeightedAvgEntry(0, 0, 100, 0)).toBe(100);
  });
  it('returns newPrice when existingSize is 0', () => {
    expect(calcWeightedAvgEntry(0, 0, 150, 1)).toBe(150);
  });
  it('correctly weights two entries', () => {
    // 1 unit @ 100 + 1 unit @ 200 = avg 150
    expect(calcWeightedAvgEntry(100, 1, 200, 1)).toBe(150);
  });
  it('weights by size correctly', () => {
    // 3 units @ 100 + 1 unit @ 200 = (300+200)/4 = 125
    expect(calcWeightedAvgEntry(100, 3, 200, 1)).toBe(125);
  });
});

describe('calcStopLoss', () => {
  it('long SL is below entry', () => {
    // Level 0: 3% SL → 100 * 0.97 = 97
    expect(calcStopLoss('long', 100, 0)).toBe(97);
  });
  it('short SL is above entry', () => {
    // Level 0: 3% SL → 100 * 1.03 = 103
    expect(calcStopLoss('short', 100, 0)).toBe(103);
  });
  it('SL tightens at higher levels', () => {
    const sl0 = calcStopLoss('long', 100, 0); // 97
    const sl1 = calcStopLoss('long', 100, 1); // 97.5
    const sl2 = calcStopLoss('long', 100, 2); // 98
    const sl3 = calcStopLoss('long', 100, 3); // 98.5
    expect(sl0).toBeLessThan(sl1);
    expect(sl1).toBeLessThan(sl2);
    expect(sl2).toBeLessThan(sl3);
  });
  it('uses custom pcts', () => {
    expect(calcStopLoss('long', 1000, 0, [5.0])).toBe(950);
  });
});

describe('calcLevelSize', () => {
  it('level 0 with default ratios [1,1,2,4] = 1/8', () => {
    expect(calcLevelSize(0, 8, [1, 1, 2, 4])).toBe(1);
  });
  it('level 2 with default ratios = 2/8', () => {
    expect(calcLevelSize(2, 8, [1, 1, 2, 4])).toBe(2);
  });
  it('level 3 with default ratios = 4/8', () => {
    expect(calcLevelSize(3, 8, [1, 1, 2, 4])).toBe(4);
  });
  it('returns 0 for zero maxKellySize', () => {
    expect(calcLevelSize(0, 0, [1, 1, 2, 4])).toBe(0);
  });
});

describe('kellyFraction', () => {
  it('returns 0 for less than 5 trades', () => {
    expect(kellyFraction([1, 2], [-1])).toBe(0);
  });
  it('returns 0 for all losses', () => {
    expect(kellyFraction([], [-1, -2, -3, -4, -5])).toBe(0);
  });
  it('returns 0 when avgLoss is 0 (all wins, no losses)', () => {
    expect(kellyFraction([1, 2, 3, 4, 5], [])).toBe(0);
  });
  it('returns positive fraction for profitable history', () => {
    // 4 wins of $2, 1 loss of $1 → p=0.8, b=2, kelly=(0.8*2-0.2)/2=0.7, half=0.35→capped 0.25
    const f = kellyFraction([2, 2, 2, 2], [1]);
    expect(f).toBe(0.25); // capped
  });
  it('returns small fraction for slightly-better-than-even', () => {
    // 3 wins, 2 losses: p=0.6, q=0.4, b=1, kelly=(0.6-0.4)/1=0.2, half=0.1
    const f = kellyFraction([1, 1, 1], [1, 1]);
    expect(f).toBeCloseTo(0.1, 2);
  });
  it('caps at 0.25', () => {
    const f = kellyFraction([10, 10, 10, 10, 10], [1]);
    expect(f).toBeLessThanOrEqual(0.25);
  });
  it('returns 0 for negative kelly (more losses than wins)', () => {
    const f = kellyFraction([1], [2, 2, 2, 2]);
    expect(f).toBe(0);
  });
});

describe('kellyToContractSize', () => {
  it('returns 0 for zero price', () => {
    expect(kellyToContractSize(0.1, 1000, 10, 0)).toBe(0);
  });
  it('returns minimum 0.01 for tiny fraction', () => {
    expect(kellyToContractSize(0.001, 10, 10, 50000)).toBe(0.01);
  });
  it('calculates correctly for known values', () => {
    // 10% of $1000 = $100 margin, 10x = $1000 notional, at $100/coin = 10 contracts
    expect(kellyToContractSize(0.1, 1000, 10, 100)).toBe(10);
  });
});
