import { describe, it, expect } from 'vitest';
import { buildFeatureSnapshot } from '../agent/cognition/feature-builder.mjs';

function makeCandles(count, start = 100, drift = 0.5) {
  return Array.from({ length: count }, (_, idx) => {
    const base = start + idx * drift;
    return {
      ts: 1700000000000 + idx * 3600000,
      open: base,
      high: base + 2,
      low: base - 1,
      close: base + 1,
      volume: 1000 + idx * 5,
    };
  });
}

describe('feature builder', () => {
  it('builds time and supply metrics without crashing near boundaries', () => {
    const candles = makeCandles(220);
    const marketStates = candles.map((c, idx) => ({
      ts: c.ts,
      funding_rate: 0.0005 + idx * 0.00001,
      open_interest: 1000000 + idx * 1000,
      oi_change_24h: 1 + idx * 0.02,
      mark_price: c.close + 0.2,
      index_price: c.close,
      basis_bps: 5,
      source: 'test',
    }));

    const features = buildFeatureSnapshot({ candles, marketStates, timeframe: '1H' });

    expect(features.regime).toBeTypeOf('string');
    expect(features.bars_in_regime).toBeGreaterThan(0);
    expect(features.days_in_regime).toBeGreaterThan(0);
    expect(features.bars_since_breakout).toBeGreaterThanOrEqual(0);
    expect(features.distance_to_ath_pct).toBeLessThanOrEqual(0);
    expect(features.overhead_supply_score_90d).toBeGreaterThanOrEqual(0);
    expect(features.overhead_supply_score_90d).toBeLessThanOrEqual(100);
    expect(features.oi_zscore_30d).toBeTypeOf('number');
    expect(features.funding_zscore_30d).toBeTypeOf('number');
    expect(features.atr_pct).toBeGreaterThan(0);
  });

  it('falls back safely when market state history is missing', () => {
    const candles = makeCandles(120, 200, -0.4);
    const features = buildFeatureSnapshot({ candles, marketStates: [], timeframe: '1H' });

    expect(features.open_interest).toBe(0);
    expect(features.funding_rate).toBe(0);
    expect(features.oi_zscore_30d).toBe(0);
    expect(features.funding_zscore_30d).toBe(0);
    expect(features.overhead_supply_score_365d).toBeGreaterThanOrEqual(0);
  });
});

