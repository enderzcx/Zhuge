import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createScheduler } from '../../../kernel/scheduler/index.mjs';
import { createEventStore } from '../../../kernel/event-store/index.mjs';
import { registerTraderTasks } from '../../../harness/trader/orchestration.mjs';

describe('Trader Orchestration', () => {
  let scheduler;
  let eventStore;
  let mockPipeline;
  let mockScanner;
  let mockBitgetExec;

  beforeEach(() => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    eventStore = createEventStore({ db });
    scheduler = createScheduler({ eventStore });

    mockPipeline = { collectAndAnalyze: vi.fn(async () => 30) };
    mockScanner = { reviewPendingOrders: vi.fn(async () => {}) };
    mockBitgetExec = { checkAndSyncTrades: vi.fn(async () => {}) };
  });

  it('registers 5 tasks', () => {
    registerTraderTasks({
      scheduler, eventStore, pipeline: mockPipeline, scanner: mockScanner,
      bitgetExec: mockBitgetExec, bitgetWS: { isHealthy: () => true },
      compound: { shouldRun: () => false, run: async () => {} }, cache: {}, log: {},
    });
    expect(scheduler.size()).toBe(5);
    expect(scheduler.has('trader.analysis_cycle')).toBe(true);
    expect(scheduler.has('trader.trade_sync')).toBe(true);
    expect(scheduler.has('trader.compound_check')).toBe(true);
    expect(scheduler.has('trader.intel_flash')).toBe(true);
    expect(scheduler.has('trader.emergency_analysis')).toBe(true);
  });

  describe('analysis_cycle', () => {
    it('runs collectAndAnalyze and emits completion event', async () => {
      registerTraderTasks({
        scheduler, eventStore, pipeline: mockPipeline, scanner: mockScanner,
        bitgetExec: mockBitgetExec, bitgetWS: { isHealthy: () => true },
        compound: null, cache: {}, log: {},
      });

      await scheduler.trigger('trader.analysis_cycle');

      expect(mockPipeline.collectAndAnalyze).toHaveBeenCalledOnce();
      const events = eventStore.getEvents({ type: 'trader.cycle.completed' });
      expect(events).toHaveLength(1);
      expect(events[0].payload.next_check_min).toBe(30);
    });

    it('skips if last cycle was too recent', async () => {
      registerTraderTasks({
        scheduler, eventStore, pipeline: mockPipeline, scanner: mockScanner,
        bitgetExec: mockBitgetExec, bitgetWS: { isHealthy: () => true },
        compound: null, cache: {}, log: {},
      });

      // Simulate a recent completed cycle (5 min ago, interval 30 min)
      eventStore.emit({
        type: 'trader.cycle.completed',
        actor: 'test',
        ts: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        payload: { next_check_min: 30 },
      });

      await scheduler.trigger('trader.analysis_cycle');
      expect(mockPipeline.collectAndAnalyze).not.toHaveBeenCalled();
    });

    it('runs if interval has elapsed', async () => {
      registerTraderTasks({
        scheduler, eventStore, pipeline: mockPipeline, scanner: mockScanner,
        bitgetExec: mockBitgetExec, bitgetWS: { isHealthy: () => true },
        compound: null, cache: {}, log: {},
      });

      // Simulate an old completed cycle (40 min ago, interval 30 min)
      eventStore.emit({
        type: 'trader.cycle.completed',
        actor: 'test',
        ts: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
        payload: { next_check_min: 30 },
      });

      await scheduler.trigger('trader.analysis_cycle');
      expect(mockPipeline.collectAndAnalyze).toHaveBeenCalledOnce();
    });

    it('emits completion even on error (with fallback interval)', async () => {
      const failPipeline = { collectAndAnalyze: vi.fn(async () => { throw new Error('API down'); }) };
      registerTraderTasks({
        scheduler, eventStore, pipeline: failPipeline, scanner: mockScanner,
        bitgetExec: mockBitgetExec, bitgetWS: { isHealthy: () => true },
        compound: null, cache: {}, log: {},
      });

      await scheduler.trigger('trader.analysis_cycle');
      const events = eventStore.getEvents({ type: 'trader.cycle.completed' });
      expect(events).toHaveLength(1);
      expect(events[0].payload.trigger).toBe('error_fallback');
      expect(events[0].payload.next_check_min).toBe(30);
    });
  });

  describe('trade_sync', () => {
    it('syncs trades and emits completion event', async () => {
      registerTraderTasks({
        scheduler, eventStore, pipeline: mockPipeline, scanner: mockScanner,
        bitgetExec: mockBitgetExec, bitgetWS: { isHealthy: () => false },
        compound: null, cache: {}, log: {},
      });

      await scheduler.trigger('trader.trade_sync');
      expect(mockBitgetExec.checkAndSyncTrades).toHaveBeenCalledOnce();
      expect(mockScanner.reviewPendingOrders).toHaveBeenCalledOnce();

      const events = eventStore.getEvents({ type: 'trader.trade_sync.completed' });
      expect(events).toHaveLength(1);
    });

    it('does not emit completion when sync fails', async () => {
      const failingExec = { checkAndSyncTrades: vi.fn(async () => { throw new Error('API down'); }) };
      registerTraderTasks({
        scheduler, eventStore, pipeline: mockPipeline, scanner: mockScanner,
        bitgetExec: failingExec, bitgetWS: { isHealthy: () => false },
        compound: null, cache: {}, log: {},
      });

      await scheduler.trigger('trader.trade_sync');
      const events = eventStore.getEvents({ type: 'trader.trade_sync.completed' });
      expect(events).toHaveLength(0); // No completion → will retry next cron tick
    });

    it('skips when WS healthy and synced recently', async () => {
      registerTraderTasks({
        scheduler, eventStore, pipeline: mockPipeline, scanner: mockScanner,
        bitgetExec: mockBitgetExec, bitgetWS: { isHealthy: () => true },
        compound: null, cache: {}, log: {},
      });

      // Simulate recent sync
      eventStore.emit({
        type: 'trader.trade_sync.completed',
        actor: 'test',
        payload: { ws_healthy: true },
      });

      await scheduler.trigger('trader.trade_sync');
      expect(mockBitgetExec.checkAndSyncTrades).not.toHaveBeenCalled();
    });
  });

  describe('compound_check', () => {
    it('runs compound when shouldRun returns true', async () => {
      const mockCompound = { shouldRun: vi.fn(() => true), run: vi.fn(async () => {}) };
      registerTraderTasks({
        scheduler, eventStore, pipeline: mockPipeline, scanner: mockScanner,
        bitgetExec: mockBitgetExec, bitgetWS: { isHealthy: () => true },
        compound: mockCompound, cache: {}, log: {},
      });

      await scheduler.trigger('trader.compound_check');
      expect(mockCompound.run).toHaveBeenCalledOnce();
    });

    it('skips compound when shouldRun returns false', async () => {
      const mockCompound = { shouldRun: vi.fn(() => false), run: vi.fn(async () => {}) };
      registerTraderTasks({
        scheduler, eventStore, pipeline: mockPipeline, scanner: mockScanner,
        bitgetExec: mockBitgetExec, bitgetWS: { isHealthy: () => true },
        compound: mockCompound, cache: {}, log: {},
      });

      await scheduler.trigger('trader.compound_check');
      expect(mockCompound.run).not.toHaveBeenCalled();
    });
  });

  describe('intel_flash', () => {
    it('triggers analysis when no recent cycle and not analyzing', async () => {
      registerTraderTasks({
        scheduler, eventStore, pipeline: mockPipeline, scanner: mockScanner,
        bitgetExec: mockBitgetExec, bitgetWS: { isHealthy: () => true },
        compound: null, cache: {}, log: {},
      });

      await scheduler.trigger('trader.intel_flash', { item_title: 'BTC pump' });
      expect(mockPipeline.collectAndAnalyze).toHaveBeenCalledOnce();

      // Should NOT emit trader.cycle.completed (additive)
      const cycleEvents = eventStore.getEvents({ type: 'trader.cycle.completed' });
      expect(cycleEvents).toHaveLength(0);
    });

    it('skips when last cycle was < 10min ago', async () => {
      registerTraderTasks({
        scheduler, eventStore, pipeline: mockPipeline, scanner: mockScanner,
        bitgetExec: mockBitgetExec, bitgetWS: { isHealthy: () => true },
        compound: null, cache: {}, log: {},
      });

      // Recent cycle
      eventStore.emit({
        type: 'trader.cycle.completed', actor: 'test',
        ts: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
        payload: { next_check_min: 30 },
      });

      await scheduler.trigger('trader.intel_flash', { item_title: 'BTC pump' });
      expect(mockPipeline.collectAndAnalyze).not.toHaveBeenCalled();
    });
  });

  describe('emergency_analysis', () => {
    it('triggers pipeline without resetting cycle timer', async () => {
      registerTraderTasks({
        scheduler, eventStore, pipeline: mockPipeline, scanner: mockScanner,
        bitgetExec: mockBitgetExec, bitgetWS: { isHealthy: () => true },
        compound: null, cache: {}, log: {},
      });

      await scheduler.trigger('trader.emergency_analysis', { reason: 'drawdown_critical' });
      expect(mockPipeline.collectAndAnalyze).toHaveBeenCalledOnce();

      // Should NOT emit trader.cycle.completed (additive, doesn't reset timer)
      const events = eventStore.getEvents({ type: 'trader.cycle.completed' });
      expect(events).toHaveLength(0);
    });
  });

  describe('concurrency', () => {
    it('analysis_cycle has concurrency 1 (no double-run)', async () => {
      let resolve;
      const blockingPipeline = {
        collectAndAnalyze: vi.fn(() => new Promise(r => { resolve = r; })),
      };

      registerTraderTasks({
        scheduler, eventStore, pipeline: blockingPipeline, scanner: mockScanner,
        bitgetExec: mockBitgetExec, bitgetWS: { isHealthy: () => true },
        compound: null, cache: {}, log: {},
      });

      // First trigger blocks
      const p1 = scheduler.trigger('trader.analysis_cycle');
      // Second trigger should be skipped (concurrency 1)
      const execId2 = await scheduler.trigger('trader.analysis_cycle');
      expect(execId2).toBeNull();

      resolve(30);
      await p1;
    });
  });
});
