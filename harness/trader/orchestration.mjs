/**
 * Trader Harness — Orchestration.
 *
 * Registers all trader tasks in the kernel scheduler, replacing the
 * 6 inline loops from index.mjs:
 *   1. Analysis loop (AI-driven timing)
 *   2. Trade sync (adaptive 5-30min)
 *   3. K-line signal reaction (event-driven)
 *   4. Compound knowledge (threshold-triggered)
 *   5. Intel flash (event-driven)
 *   6. Drawdown monitor (real-time WS — stays as callback, emits events)
 *
 * The scheduler replaces setTimeout/setInterval with kernel primitives.
 * Drawdown monitor stays as WS callback (sub-second latency requirement).
 */

/**
 * Register all trader tasks in the kernel scheduler.
 *
 * @param {{
 *   scheduler: import('../../kernel/scheduler/index.mjs').Scheduler,
 *   eventStore: import('../../kernel/event-store/index.mjs').EventStore,
 *   pipeline: { collectAndAnalyze: Function },
 *   scanner: { reviewPendingOrders: Function },
 *   bitgetExec: { checkAndSyncTrades: Function },
 *   bitgetWS: { isHealthy: Function },
 *   compound: { shouldRun: Function, run: Function },
 *   cache: object,
 *   log: object,
 * }} deps
 */
export function registerTraderTasks({ scheduler, eventStore, pipeline, scanner, bitgetExec, bitgetWS, compound, cache, log }) {
  const noop = () => {};
  const _log = log && typeof log.info === 'function' ? log : { info: noop, warn: noop, error: noop };

  // Cross-task mutex: prevent intel/emergency from overlapping with analysis cycle
  let _analyzing = false;

  // ── 1. Analysis Cycle ──
  // Cron every minute, guard checks if enough time has passed since last cycle.
  // AI decides the interval (10-240min) stored in event store.
  scheduler.register({
    name: 'trader.analysis_cycle',
    trigger: { type: 'cron', expr: '* * * * *' }, // every minute
    concurrency: 1,
    timeout_ms: 10 * 60 * 1000, // 10 min max
    handler: async (ctx) => {
      // Guard: check time since last completed cycle
      const lastEvents = eventStore.getEvents({
        type: 'trader.cycle.completed',
        order: 'desc',
        limit: 1,
      });

      let intervalMin = 30; // default
      if (lastEvents.length > 0) {
        const last = lastEvents[0];
        intervalMin = last.payload?.next_check_min || 30;
        const elapsedMs = Date.now() - new Date(last.ts).getTime();
        const intervalMs = intervalMin * 60 * 1000;
        if (elapsedMs < intervalMs) {
          return; // Not yet due — skip this cron tick
        }
      }

      _log.info('analysis_cycle_start', { module: 'orchestration', trigger: ctx.trigger });
      _analyzing = true;

      try {
        const nextMin = await pipeline.collectAndAnalyze();
        scanner.reviewPendingOrders().catch(e =>
          _log.error('pending_review_error', { module: 'orchestration', error: e.message }));

        eventStore.emit({
          type: 'trader.cycle.completed',
          actor: 'harness:trader:orchestration',
          trace_id: ctx.execution_id,
          payload: { next_check_min: nextMin || 30, trigger: ctx.trigger },
        });
      } catch (err) {
        _log.error('analysis_cycle_error', { module: 'orchestration', error: err.message });
        // On error, emit completed with default interval so next cycle still happens
        eventStore.emit({
          type: 'trader.cycle.completed',
          actor: 'harness:trader:orchestration',
          trace_id: ctx.execution_id,
          payload: { next_check_min: 30, trigger: 'error_fallback', error: err.message },
        });
      } finally {
        _analyzing = false;
      }
    },
  });

  // ── 2. Trade Sync ──
  // Every 5 minutes. Handler checks WS health and acts accordingly.
  scheduler.register({
    name: 'trader.trade_sync',
    trigger: { type: 'cron', expr: '*/5 * * * *' },
    concurrency: 1,
    timeout_ms: 2 * 60 * 1000,
    handler: async () => {
      // When WS healthy, only sync every 30min (skip 5 out of 6 ticks)
      if (bitgetWS.isHealthy()) {
        const lastSync = eventStore.getEvents({
          type: 'trader.trade_sync.completed',
          order: 'desc',
          limit: 1,
        });
        if (lastSync.length > 0) {
          const elapsed = Date.now() - new Date(lastSync[0].ts).getTime();
          if (elapsed < 25 * 60 * 1000) return; // skip — WS healthy, synced recently
        }
      }

      let syncOk = true;
      try {
        await bitgetExec.checkAndSyncTrades();
      } catch (e) {
        syncOk = false;
        _log.error('trade_sync_error', { module: 'orchestration', error: e.message });
      }
      try {
        await scanner.reviewPendingOrders();
      } catch (e) {
        _log.error('pending_review_error', { module: 'orchestration', error: e.message });
      }

      // Only record completion if sync succeeded (so guard doesn't skip retries)
      if (syncOk) {
        eventStore.emit({
          type: 'trader.trade_sync.completed',
          actor: 'harness:trader:orchestration',
          payload: { ws_healthy: bitgetWS.isHealthy() },
        });
      }
    },
  });

  // ── 3. Compound Knowledge ──
  // Check every 30 minutes if enough trades accumulated.
  scheduler.register({
    name: 'trader.compound_check',
    trigger: { type: 'cron', expr: '*/30 * * * *' },
    concurrency: 1,
    timeout_ms: 5 * 60 * 1000,
    handler: async (ctx) => {
      if (!compound?.shouldRun()) return;
      _log.info('compound_trigger', { module: 'orchestration' });
      await compound.run();
      eventStore.emit({
        type: 'trader.compound.completed',
        actor: 'harness:trader:orchestration',
        trace_id: ctx.execution_id,
        payload: {},
      });
    },
  });

  // ── 4. Intel Flash Trigger ──
  // Manual trigger — called by intelStream.setTriggerHandler callback.
  scheduler.register({
    name: 'trader.intel_flash',
    trigger: { type: 'manual' },
    concurrency: 1,
    timeout_ms: 10 * 60 * 1000,
    handler: async (ctx) => {
      // Overlap guard: skip if analysis cycle is in progress
      if (_analyzing) return;
      // Overlap guard: skip if last cycle was < 10min ago
      const lastCycle = eventStore.getEvents({
        type: 'trader.cycle.completed',
        order: 'desc',
        limit: 1,
      });
      if (lastCycle.length > 0) {
        const elapsed = Date.now() - new Date(lastCycle[0].ts).getTime();
        if (elapsed < 10 * 60 * 1000) return;
      }

      _log.info('intel_flash_analysis', { module: 'orchestration', item: ctx.item_title });
      await pipeline.collectAndAnalyze();
      // Do NOT emit trader.cycle.completed — flash runs are additive,
      // they must not reset the regular cycle timer.
    },
  });

  // ── 5. Emergency Analysis (drawdown) ──
  // Manual trigger — called by drawdown WS callback.
  scheduler.register({
    name: 'trader.emergency_analysis',
    trigger: { type: 'manual' },
    concurrency: 1,
    timeout_ms: 10 * 60 * 1000,
    handler: async (ctx) => {
      // Emergency DOES run even if analyzing (drawdown is critical safety)
      _log.warn('emergency_analysis', { module: 'orchestration', reason: ctx.reason });
      await pipeline.collectAndAnalyze();
      // Do NOT emit trader.cycle.completed — emergency runs are additive,
      // they must not reset the regular cycle timer.
    },
  });

  _log.info('trader_tasks_registered', { module: 'orchestration', count: scheduler.size() });
}

/**
 * Wire the drawdown monitor and intel trigger to emit events / trigger scheduler.
 *
 * These stay as WS/stream callbacks (sub-second latency requirement)
 * but route through the scheduler for concurrency control.
 *
 * @param {{
 *   scheduler: Scheduler,
 *   eventStore: EventStore,
 *   bitgetWS: object,
 *   intelStream: object,
 *   pushEngine: object,
 *   cache: object,
 *   log: object,
 * }} deps
 */
export function wireTraderCallbacks({ scheduler, eventStore, bitgetWS, intelStream, pushEngine, cache, config, log }) {
  const _log = log || { info() {}, warn() {}, error() {} };
  let _lastDrawdownAlert = 0;

  // Drawdown monitor: real-time WS callback → scheduler trigger
  bitgetWS.onPositionUpdate((positions) => {
    if (!bitgetWS.isHealthy()) return;
    const equity = bitgetWS.getEquity();
    if (equity <= 0) return;
    const totalPnL = bitgetWS.getUnrealizedPnL();
    const lossPct = -totalPnL / equity;

    if (lossPct >= 0.05 && Date.now() - _lastDrawdownAlert > 5 * 60 * 1000) {
      _lastDrawdownAlert = Date.now();
      _log.error('drawdown_critical', { module: 'orchestration', totalPnL: totalPnL.toFixed(2), equity: equity.toFixed(2), lossPct: (lossPct * 100).toFixed(1) });
      pushEngine?.pushError?.({ source: 'risk_monitor', message: `浮亏 ${totalPnL.toFixed(2)} USDT (${(lossPct * 100).toFixed(1)}% 权益)，已触发紧急分析` });
      scheduler.triggerAsync('trader.emergency_analysis', { reason: 'drawdown_critical', lossPct });
    } else if (lossPct >= 0.03 && Date.now() - _lastDrawdownAlert > 5 * 60 * 1000) {
      _lastDrawdownAlert = Date.now();
      _log.warn('drawdown_warning', { module: 'orchestration', totalPnL: totalPnL.toFixed(2), equity: equity.toFixed(2), lossPct: (lossPct * 100).toFixed(1) });
      scheduler.triggerAsync('trader.emergency_analysis', { reason: 'drawdown_warning', lossPct });
    }
  });

  // Intel flash: stream callback → scheduler trigger
  intelStream.setTriggerHandler((item) => {
    _log.info('intel_flash_trigger', { module: 'orchestration', title: (item.title || '').slice(0, 80), score: item.score });
    scheduler.triggerAsync('trader.intel_flash', { item_title: (item.title || '').slice(0, 80) });
  });
}
