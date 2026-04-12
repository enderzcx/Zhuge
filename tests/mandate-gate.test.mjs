import { describe, it, expect, vi } from 'vitest';
import { createMandateGate } from '../agents/mandate-gate.mjs';

/**
 * Mandate Gate tests — 道枢坐标: (Harness, Keystone)
 *
 * These tests verify that hard rules are deterministic and do not depend on LLM.
 * The mandate gate must VETO on any unsafe state and PASS only when all rules clear.
 */

function createMockDeps(overrides = {}) {
  const db = {
    prepare: vi.fn(() => ({
      all: vi.fn(() => []),
      get: vi.fn(() => null),
    })),
  };
  const config = {
    SCALING: overrides.scaling || null,
  };
  const bitgetClient = {
    bitgetRequest: overrides.bitgetRequest || vi.fn(async () => []),
  };
  const bitgetWS = {
    isHealthy: overrides.wsHealthy ?? (() => true),
    getEquity: overrides.wsEquity ?? (() => 100),
    getUnrealizedPnL: overrides.wsUnrealizedPnL ?? (() => 0),
  };
  const messageBus = { postMessage: vi.fn() };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  return { db, config, bitgetClient, bitgetWS, messageBus, log };
}

describe('Mandate Gate', () => {

  it('should PASS when all rules clear', async () => {
    const deps = createMockDeps();
    // Mock: no closed trades in 24h, equity = 100
    deps.db.prepare = vi.fn((sql) => {
      if (sql.includes('closed_at >')) return { all: () => [] }; // no 24h losses
      if (sql.includes('ORDER BY closed_at DESC')) return { all: () => [], get: () => null };
      return { all: () => [], get: () => null };
    });
    const gate = createMandateGate(deps);
    const result = await gate.check({ pair: 'BTCUSDT' }, 'test_trace');
    expect(result.verdict).toBe('PASS');
  });

  it('should VETO when equity cannot be fetched (fail-closed)', async () => {
    const deps = createMockDeps({
      wsHealthy: () => false,
      wsEquity: () => 0,
      bitgetRequest: vi.fn(async () => { throw new Error('network error'); }),
    });
    deps.db.prepare = vi.fn(() => ({ all: () => [], get: () => null }));
    const gate = createMandateGate(deps);
    const result = await gate.check({ pair: 'BTCUSDT' }, 'test_trace');
    expect(result.verdict).toBe('VETO');
    expect(result.rule).toBe('equity_unknown');
  });

  it('should VETO when 24h loss exceeds 5%', async () => {
    const deps = createMockDeps({
      wsEquity: () => 100,
      wsUnrealizedPnL: () => 0,
    });
    deps.db.prepare = vi.fn((sql) => {
      if (sql.includes('closed_at >')) {
        // 24h trades with -6 USDT total loss (6% of 100 equity)
        return { all: () => [{ pnl: -3 }, { pnl: -3 }] };
      }
      if (sql.includes('ORDER BY closed_at DESC')) return { all: () => [], get: () => null };
      return { all: () => [], get: () => null };
    });
    const gate = createMandateGate(deps);
    const result = await gate.check({ pair: 'BTCUSDT' }, 'test_trace');
    expect(result.verdict).toBe('VETO');
    expect(result.rule).toBe('24h_loss_limit');
  });

  it('should VETO on consecutive losses with active cooldown', async () => {
    const recentTime = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace('Z', ''); // 10 min ago, no Z suffix (DB stores without Z)
    const deps = createMockDeps();
    deps.db.prepare = vi.fn((sql) => {
      // Rule 1: consecutive losses query (LIMIT 10)
      if (sql.includes('pnl') && sql.includes('LIMIT 10')) {
        return { all: () => [{ pnl: -1 }, { pnl: -2 }, { pnl: -0.5 }] };
      }
      // Rule 1: last loss time query (LIMIT 1)
      if (sql.includes('pnl < 0') && sql.includes('LIMIT 1')) {
        return { get: () => ({ closed_at: recentTime }) };
      }
      // Rule 3: 24h losses
      if (sql.includes('closed_at >')) return { all: () => [] };
      return { all: () => [], get: () => null };
    });
    const gate = createMandateGate(deps);
    const result = await gate.check({ pair: 'BTCUSDT' }, 'test_trace');
    expect(result.verdict).toBe('VETO');
    expect(result.rule).toBe('consecutive_loss_cooldown');
  });

  it('should PASS for scout even with consecutive losses', async () => {
    const recentTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const deps = createMockDeps();
    deps.db.prepare = vi.fn((sql) => {
      if (sql.includes('ORDER BY closed_at DESC LIMIT 10')) {
        return { all: () => [{ pnl: -1 }, { pnl: -2 }, { pnl: -0.5 }] };
      }
      if (sql.includes('ORDER BY closed_at DESC LIMIT 1')) {
        return { get: () => ({ closed_at: recentTime }) };
      }
      if (sql.includes('closed_at >')) return { all: () => [] };
      return { all: () => [], get: () => null };
    });
    const gate = createMandateGate(deps);
    const result = await gate.check({ pair: 'BTCUSDT' }, 'test_trace', { isScout: true });
    expect(result.verdict).toBe('PASS');
  });

  it('should VETO when total exposure exceeds limit (scaling mode)', async () => {
    const deps = createMockDeps({
      scaling: { enabled: true, max_exposure_eth: 1.0 },
    });
    deps.db.prepare = vi.fn((sql) => {
      if (sql.includes("status = 'active'")) {
        return { all: () => [{ total_size: 0.6, symbol: 'ETHUSDT' }, { total_size: 0.5, symbol: 'BTCUSDT' }] };
      }
      if (sql.includes('closed_at >')) return { all: () => [] };
      if (sql.includes('ORDER BY closed_at DESC')) return { all: () => [], get: () => null };
      return { all: () => [], get: () => null };
    });
    const gate = createMandateGate(deps);
    const result = await gate.check({ pair: 'SOLUSDT' }, 'test_trace');
    expect(result.verdict).toBe('VETO');
    expect(result.rule).toBe('max_exposure');
  });

  it('should not import or call any LLM modules', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync(new URL('../agents/mandate-gate.mjs', import.meta.url), 'utf-8');
    // Check for actual import statements, not comments
    expect(source).not.toMatch(/import\s.*agentRunner/);
    expect(source).not.toMatch(/import\s.*runAgent/);
    expect(source).not.toMatch(/import\s.*createLLM/);
    expect(source).not.toMatch(/import\s.*llm/);
  });
});
