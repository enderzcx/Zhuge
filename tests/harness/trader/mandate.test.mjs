import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createMandateGate } from '../../../kernel/mandate/gate.mjs';
import { TRADER_CONSTRAINTS, loadTraderMandate, buildMandateContext } from '../../../harness/trader/mandate.mjs';

describe('Trader Mandate (Harness)', () => {
  let gate;

  beforeEach(() => {
    gate = createMandateGate();
    loadTraderMandate(gate);
  });

  it('loads 4 constraints', () => {
    expect(gate.listRules('trader')).toHaveLength(4);
  });

  describe('consecutive_loss_cooldown', () => {
    it('passes when losses below threshold', () => {
      const result = gate.check('trader', 'open_trade', {
        is_scout: false, consecutive_losses: 2, loss_threshold: 3, cooldown_expired: false,
        scaling_enabled: false, total_exposure: 0, max_exposure_eth: 1,
        loss_24h_abs: 0, loss_threshold_abs: 100, equity: 1000,
      });
      expect(result.pass).toBe(true);
    });

    it('vetoes when losses at threshold and cooldown not expired', () => {
      const result = gate.check('trader', 'open_trade', {
        is_scout: false, consecutive_losses: 3, loss_threshold: 3, cooldown_expired: false,
        scaling_enabled: false, total_exposure: 0, max_exposure_eth: 1,
        loss_24h_abs: 0, loss_threshold_abs: 100, equity: 1000,
      });
      expect(result.pass).toBe(false);
      expect(result.vetoed_by.id).toBe('consecutive_loss_cooldown');
    });

    it('passes for scout even with losses', () => {
      const result = gate.check('trader', 'open_trade', {
        is_scout: true, consecutive_losses: 5, loss_threshold: 3, cooldown_expired: false,
        scaling_enabled: false, total_exposure: 0, max_exposure_eth: 1,
        loss_24h_abs: 0, loss_threshold_abs: 100, equity: 1000,
      });
      expect(result.pass).toBe(true);
    });

    it('passes when cooldown expired', () => {
      const result = gate.check('trader', 'open_trade', {
        is_scout: false, consecutive_losses: 5, loss_threshold: 3, cooldown_expired: true,
        scaling_enabled: false, total_exposure: 0, max_exposure_eth: 1,
        loss_24h_abs: 0, loss_threshold_abs: 100, equity: 1000,
      });
      expect(result.pass).toBe(true);
    });
  });

  describe('max_exposure', () => {
    it('passes when scaling disabled', () => {
      const result = gate.check('trader', 'open_trade', {
        is_scout: false, consecutive_losses: 0, loss_threshold: 3, cooldown_expired: true,
        scaling_enabled: false, total_exposure: 999, max_exposure_eth: 1,
        loss_24h_abs: 0, loss_threshold_abs: 100, equity: 1000,
      });
      expect(result.pass).toBe(true);
    });

    it('vetoes when exposure exceeds limit', () => {
      const result = gate.check('trader', 'open_trade', {
        is_scout: false, consecutive_losses: 0, loss_threshold: 3, cooldown_expired: true,
        scaling_enabled: true, total_exposure: 1.5, max_exposure_eth: 1.0,
        loss_24h_abs: 0, loss_threshold_abs: 100, equity: 1000,
      });
      expect(result.pass).toBe(false);
      expect(result.vetoed_by.id).toBe('max_exposure');
    });
  });

  describe('24h_loss_limit', () => {
    it('passes when loss below threshold', () => {
      const result = gate.check('trader', 'open_trade', {
        is_scout: false, consecutive_losses: 0, loss_threshold: 3, cooldown_expired: true,
        scaling_enabled: false, total_exposure: 0, max_exposure_eth: 1,
        loss_24h_abs: 30, loss_threshold_abs: 50, equity: 1000,
      });
      expect(result.pass).toBe(true);
    });

    it('vetoes when loss exceeds threshold', () => {
      const result = gate.check('trader', 'open_trade', {
        is_scout: false, consecutive_losses: 0, loss_threshold: 3, cooldown_expired: true,
        scaling_enabled: false, total_exposure: 0, max_exposure_eth: 1,
        loss_24h_abs: 60, loss_threshold_abs: 50, equity: 1000,
      });
      expect(result.pass).toBe(false);
      expect(result.vetoed_by.id).toBe('24h_loss_limit');
    });
  });

  describe('equity_unknown', () => {
    it('vetoes when equity is 0', () => {
      const result = gate.check('trader', 'open_trade', {
        is_scout: false, consecutive_losses: 0, loss_threshold: 3, cooldown_expired: true,
        scaling_enabled: false, total_exposure: 0, max_exposure_eth: 1,
        loss_24h_abs: 0, loss_threshold_abs: 0, equity: 0,
      });
      expect(result.pass).toBe(false);
      expect(result.vetoed_by.id).toBe('equity_unknown');
    });
  });

  describe('skips non-matching actions', () => {
    it('passes for close_position (no constraints match)', () => {
      const result = gate.check('trader', 'close_trade', {});
      expect(result.pass).toBe(true);
    });
  });
});

describe('buildMandateContext', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE trades (id INTEGER PRIMARY KEY, pnl REAL, status TEXT, closed_at TEXT);
      CREATE TABLE position_groups (id INTEGER PRIMARY KEY, pnl REAL, total_size REAL, status TEXT, symbol TEXT, closed_at TEXT);
    `);
  });

  it('returns all required fields', async () => {
    const ctx = await buildMandateContext({
      db,
      config: {},
      bitgetClient: { bitgetRequest: async () => [] },
      bitgetWS: { isHealthy: () => true, getEquity: () => 1000, getUnrealizedPnL: () => -10 },
    });

    expect(ctx).toHaveProperty('is_scout');
    expect(ctx).toHaveProperty('consecutive_losses');
    expect(ctx).toHaveProperty('loss_threshold');
    expect(ctx).toHaveProperty('cooldown_expired');
    expect(ctx).toHaveProperty('scaling_enabled');
    expect(ctx).toHaveProperty('total_exposure');
    expect(ctx).toHaveProperty('max_exposure_eth');
    expect(ctx).toHaveProperty('loss_24h_abs');
    expect(ctx).toHaveProperty('loss_threshold_abs');
    expect(ctx).toHaveProperty('equity');
  });

  it('counts consecutive losses from trades table', async () => {
    db.prepare("INSERT INTO trades (pnl, status, closed_at) VALUES (?, 'closed', ?)").run(-10, new Date().toISOString());
    db.prepare("INSERT INTO trades (pnl, status, closed_at) VALUES (?, 'closed', ?)").run(-5, new Date(Date.now() - 1000).toISOString());
    db.prepare("INSERT INTO trades (pnl, status, closed_at) VALUES (?, 'closed', ?)").run(20, new Date(Date.now() - 2000).toISOString());

    const ctx = await buildMandateContext({
      db, config: {},
      bitgetClient: { bitgetRequest: async () => [] },
      bitgetWS: { isHealthy: () => true, getEquity: () => 1000, getUnrealizedPnL: () => 0 },
    });

    expect(ctx.consecutive_losses).toBe(2);
    expect(ctx.loss_threshold).toBe(3);
  });

  it('computes equity from WS', async () => {
    const ctx = await buildMandateContext({
      db, config: {},
      bitgetClient: { bitgetRequest: async () => [] },
      bitgetWS: { isHealthy: () => true, getEquity: () => 500, getUnrealizedPnL: () => 0 },
    });
    expect(ctx.equity).toBe(500);
    expect(ctx.loss_threshold_abs).toBe(25); // 500 * 0.05
  });

  it('includes unrealized loss in 24h calculation', async () => {
    const ctx = await buildMandateContext({
      db, config: {},
      bitgetClient: { bitgetRequest: async () => [] },
      bitgetWS: { isHealthy: () => true, getEquity: () => 1000, getUnrealizedPnL: () => -30 },
    });
    expect(ctx.loss_24h_abs).toBe(30); // abs(-30)
  });
});
