import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createObservability } from '../../kernel/observability/index.mjs';
import { createEventStore } from '../../kernel/event-store/index.mjs';

describe('Observability', () => {
  let obs;
  let eventStore;

  beforeEach(() => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    eventStore = createEventStore({ db });
    obs = createObservability({ eventStore });
  });

  it('subscribes and generates metrics from events', () => {
    obs.subscribe({
      event_type: 'capability.executed',
      reducer: (event) => ({
        metric: 'capability_calls_total',
        labels: { name: event.payload.name },
        value: 1,
      }),
    });

    eventStore.emit({ type: 'capability.executed', actor: 'gw', payload: { name: 'get_price', ok: true } });
    eventStore.emit({ type: 'capability.executed', actor: 'gw', payload: { name: 'get_price', ok: true } });
    eventStore.emit({ type: 'capability.executed', actor: 'gw', payload: { name: 'open_trade', ok: true } });

    obs.processEvents();

    expect(obs.getMetric('capability_calls_total', { name: 'get_price' })).toBe(2);
    expect(obs.getMetric('capability_calls_total', { name: 'open_trade' })).toBe(1);
  });

  it('subscribes to multiple event types', () => {
    obs.subscribe({
      event_type: ['scheduler.task_completed', 'scheduler.task_failed'],
      reducer: (event) => ({
        metric: 'scheduler_executions_total',
        labels: { status: event.type.includes('completed') ? 'ok' : 'error' },
        value: 1,
      }),
    });

    eventStore.emit({ type: 'scheduler.task_completed', actor: 's', payload: {} });
    eventStore.emit({ type: 'scheduler.task_failed', actor: 's', payload: {} });
    eventStore.emit({ type: 'scheduler.task_completed', actor: 's', payload: {} });

    obs.processEvents();

    expect(obs.getMetric('scheduler_executions_total', { status: 'ok' })).toBe(2);
    expect(obs.getMetric('scheduler_executions_total', { status: 'error' })).toBe(1);
  });

  it('subscribes to wildcard *', () => {
    obs.subscribe({
      event_type: '*',
      reducer: () => ({ metric: 'total_events', value: 1 }),
    });

    eventStore.emit({ type: 'a', actor: 'x', payload: {} });
    eventStore.emit({ type: 'b', actor: 'y', payload: {} });

    obs.processEvents();

    expect(obs.getMetric('total_events')).toBe(2);
  });

  it('getMetrics returns all metrics', () => {
    obs.subscribe({
      event_type: '*',
      reducer: (e) => ({ metric: 'count', labels: { type: e.type }, value: 1 }),
    });

    eventStore.emit({ type: 'x', actor: 'a', payload: {} });
    obs.processEvents();

    const metrics = obs.getMetrics();
    expect(metrics.length).toBeGreaterThan(0);
    expect(metrics[0].name).toBe('count');
    expect(metrics[0].labels.type).toBe('x');
  });

  it('handles reducer errors gracefully', () => {
    obs.subscribe({
      event_type: '*',
      reducer: () => { throw new Error('bad reducer'); },
    });

    eventStore.emit({ type: 'x', actor: 'a', payload: {} });
    // Should not throw
    expect(() => obs.processEvents()).not.toThrow();
  });

  it('only processes new events on subsequent calls', () => {
    obs.subscribe({
      event_type: '*',
      reducer: () => ({ metric: 'counter', value: 1 }),
    });

    eventStore.emit({ type: 'a', actor: 'x', payload: {} });
    obs.processEvents();
    expect(obs.getMetric('counter')).toBe(1);

    // Process again — no new events
    obs.processEvents();
    expect(obs.getMetric('counter')).toBe(1);

    // New event
    eventStore.emit({ type: 'b', actor: 'x', payload: {} });
    obs.processEvents();
    expect(obs.getMetric('counter')).toBe(2);
  });

  it('reset clears all metrics', () => {
    obs.subscribe({ event_type: '*', reducer: () => ({ metric: 'x', value: 1 }) });
    eventStore.emit({ type: 'a', actor: 'x', payload: {} });
    obs.processEvents();
    expect(obs.getMetric('x')).toBe(1);

    obs.reset();
    expect(obs.getMetric('x')).toBeUndefined();
  });
});
