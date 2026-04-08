import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runBacktest } from '../backtest/engine.mjs';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE compound_strategies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_id TEXT UNIQUE NOT NULL,
      family_id TEXT,
      version_id TEXT,
      role TEXT,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      direction TEXT NOT NULL DEFAULT 'long',
      symbols TEXT NOT NULL DEFAULT '[]',
      timeframe TEXT DEFAULT '1H',
      entry_conditions TEXT NOT NULL DEFAULT '[]',
      exit_conditions TEXT NOT NULL DEFAULT '[]',
      sizing_json TEXT NOT NULL DEFAULT '{}',
      risk_params_json TEXT DEFAULT '{}',
      target_json TEXT DEFAULT '{}',
      execution_json TEXT DEFAULT '{}',
      status TEXT DEFAULT 'active',
      confidence REAL DEFAULT 0.5
    );

    CREATE TABLE compound_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id TEXT UNIQUE,
      family_id TEXT,
      version_id TEXT,
      scope TEXT DEFAULT 'global',
      description TEXT NOT NULL,
      action TEXT,
      confidence REAL DEFAULT 0,
      status TEXT DEFAULT 'active',
      param_changes_json TEXT DEFAULT '{}'
    );

    CREATE TABLE backtest_candles (
      pair TEXT NOT NULL,
      timeframe TEXT NOT NULL DEFAULT '1H',
      ts INTEGER NOT NULL,
      open REAL,
      high REAL,
      low REAL,
      close REAL,
      volume REAL,
      UNIQUE(pair, timeframe, ts)
    );

    CREATE TABLE market_state_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pair TEXT NOT NULL,
      timeframe TEXT NOT NULL DEFAULT '1H',
      ts INTEGER NOT NULL,
      mark_price REAL,
      index_price REAL,
      open_interest REAL,
      funding_rate REAL,
      basis_bps REAL,
      oi_change_24h REAL,
      source TEXT DEFAULT 'test',
      UNIQUE(pair, timeframe, ts)
    );
  `);
  return db;
}

function seedCandles(db, count = 130) {
  const insertCandle = db.prepare(`
    INSERT INTO backtest_candles (pair, timeframe, ts, open, high, low, close, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertState = db.prepare(`
    INSERT INTO market_state_history (pair, timeframe, ts, mark_price, index_price, open_interest, funding_rate, basis_bps, oi_change_24h, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (let idx = 0; idx < count; idx++) {
    const ts = 1700000000000 + idx * 3600000;
    const base = 100 + idx * 0.8;
    const close = base + 1;
    let open = base;
    let high = close + 2;
    let low = base - 1;

    // First actionable bar after LOOKBACK should partially fill the ladder.
    if (idx === 100) {
      open = close + 0.5;
      high = close + 3;
      low = close - 6.2;
    }

    // Next bar should trigger time stop at open before any new fills.
    if (idx === 101) {
      open = close + 1.2;
      high = close + 2.5;
      low = close + 0.2;
    }

    insertCandle.run('BTCUSDT', '1H', ts, open, high, low, close, 1000 + idx * 10);
    insertState.run(
      'BTCUSDT',
      '1H',
      ts,
      close + 0.1,
      close,
      1_000_000 + idx * 1000,
      0.0005 + idx * 0.00001,
      4,
      2 + idx * 0.01,
      'test'
    );
  }
}

describe('target-position backtest', () => {
  it('applies time stop at bar open and reports ladder stats', () => {
    const db = createTestDb();
    seedCandles(db);

    db.prepare(`
      INSERT INTO compound_strategies (
        strategy_id, family_id, version_id, role, name, description, direction, symbols, timeframe,
        entry_conditions, exit_conditions, sizing_json, risk_params_json, target_json, execution_json, status, confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'wei2_probe_long',
      'wei',
      'wei2_0',
      'probe',
      'Wei2 Probe Long',
      'Target-position test strategy',
      'long',
      '["BTCUSDT"]',
      '1H',
      '[]',
      '[]',
      JSON.stringify({ leverage: 2 }),
      JSON.stringify({ tp_pct: 0.05, sl_pct: 0.02 }),
      JSON.stringify({ target_exposure_pct: 15, priority: 1, max_hold_minutes: 60 }),
      JSON.stringify({
        execution_style: 'ladder',
        rung_count: 3,
        size_curve: [0.3, 0.3, 0.4],
        spacing_multipliers: [0.25, 0.5, 0.9],
      }),
      'active',
      0.92
    );

    const result = runBacktest({
      db,
      symbol: 'BTCUSDT',
      timeframe: '1H',
      strategyId: 'wei2_probe_long',
      initialBalance: 1000,
    });

    expect(result.time_stop_count).toBeGreaterThanOrEqual(1);
    expect(result.partial_fill_count).toBeGreaterThanOrEqual(1);
    expect(result.target_changes).toBeGreaterThanOrEqual(1);
    expect(result.ladder_order_count).toBeGreaterThanOrEqual(3);
    expect(result.trades.length).toBeGreaterThanOrEqual(1);
    expect(result.trades.some((trade) => trade.reason === 'time_stop')).toBe(true);
    expect(result.decisions.some((decision) => decision.action === 'time_stop')).toBe(true);
  });
});
