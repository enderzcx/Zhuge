import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createEventStore } from '../../kernel/event-store/index.mjs';
import { ulid, validateEnvelope, buildEnvelope } from '../../kernel/event-store/envelope.mjs';

describe('ULID', () => {
  it('generates 26-char string', () => {
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)).toBe(true);
  });

  it('is monotonically increasing', () => {
    const ids = Array.from({ length: 100 }, () => ulid());
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i] > ids[i - 1]).toBe(true);
    }
  });
});

describe('validateEnvelope', () => {
  it('passes for valid envelope', () => {
    const { ok } = validateEnvelope({ type: 'test', actor: 'unit', ts: new Date().toISOString() });
    expect(ok).toBe(true);
  });

  it('fails when type missing', () => {
    const { ok, errors } = validateEnvelope({ actor: 'unit' });
    expect(ok).toBe(false);
    expect(errors.some(e => e.includes('type'))).toBe(true);
  });

  it('fails when actor missing', () => {
    const { ok, errors } = validateEnvelope({ type: 'test' });
    expect(ok).toBe(false);
    expect(errors.some(e => e.includes('actor'))).toBe(true);
  });
});

describe('buildEnvelope', () => {
  it('fills defaults', () => {
    const e = buildEnvelope({ type: 'test', actor: 'unit' });
    expect(e.id).toHaveLength(26);
    expect(e.ts).toBeTruthy();
    expect(e.payload).toEqual({});
    expect(e.trace_id).toBeNull();
  });

  it('preserves explicit values', () => {
    const e = buildEnvelope({ type: 'x', actor: 'y', trace_id: 'tr1', payload: { foo: 1 } });
    expect(e.trace_id).toBe('tr1');
    expect(e.payload.foo).toBe(1);
  });
});

describe('EventStore', () => {
  let store;
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    store = createEventStore({ db });
  });

  it('emit returns complete envelope', () => {
    const e = store.emit({ type: 'signal.detected', actor: 'harness:trader:kline' });
    expect(e.id).toHaveLength(26);
    expect(e.type).toBe('signal.detected');
    expect(e.actor).toBe('harness:trader:kline');
  });

  it('emit persists to SQLite', () => {
    store.emit({ type: 'a', actor: 'x' });
    store.emit({ type: 'b', actor: 'y' });
    const cnt = db.prepare('SELECT COUNT(*) as c FROM kernel_events').get().c;
    expect(cnt).toBe(2);
  });

  it('getEvents returns all by default', () => {
    store.emit({ type: 'a', actor: 'x' });
    store.emit({ type: 'b', actor: 'y' });
    const events = store.getEvents();
    expect(events).toHaveLength(2);
  });

  it('getEvents filters by type', () => {
    store.emit({ type: 'a', actor: 'x' });
    store.emit({ type: 'b', actor: 'y' });
    store.emit({ type: 'a', actor: 'z' });
    const events = store.getEvents({ type: 'a' });
    expect(events).toHaveLength(2);
  });

  it('getEvents filters by multiple types', () => {
    store.emit({ type: 'a', actor: 'x' });
    store.emit({ type: 'b', actor: 'y' });
    store.emit({ type: 'c', actor: 'z' });
    const events = store.getEvents({ type: ['a', 'c'] });
    expect(events).toHaveLength(2);
  });

  it('getEvents filters by actor', () => {
    store.emit({ type: 'a', actor: 'x' });
    store.emit({ type: 'b', actor: 'y' });
    const events = store.getEvents({ actor: 'x' });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('a');
  });

  it('getEvents filters by trace_id', () => {
    store.emit({ type: 'a', actor: 'x', trace_id: 'tr1' });
    store.emit({ type: 'b', actor: 'y', trace_id: 'tr2' });
    store.emit({ type: 'c', actor: 'z', trace_id: 'tr1' });
    const events = store.getEvents({ trace_id: 'tr1' });
    expect(events).toHaveLength(2);
  });

  it('getEvents respects limit', () => {
    for (let i = 0; i < 10; i++) store.emit({ type: 'a', actor: 'x' });
    const events = store.getEvents({ limit: 3 });
    expect(events).toHaveLength(3);
  });

  it('getEvents supports desc order', () => {
    store.emit({ type: 'first', actor: 'x', ts: '2026-01-01T00:00:00Z' });
    store.emit({ type: 'second', actor: 'x', ts: '2026-01-02T00:00:00Z' });
    const events = store.getEvents({ order: 'desc' });
    expect(events[0].type).toBe('second');
  });

  it('getEvents deserializes payload', () => {
    store.emit({ type: 'a', actor: 'x', payload: { score: 42, items: [1, 2] } });
    const [e] = store.getEvents();
    expect(e.payload.score).toBe(42);
    expect(e.payload.items).toEqual([1, 2]);
  });

  it('project reduces events into state', () => {
    store.emit({ type: 'counter.inc', actor: 'x', payload: { n: 1 } });
    store.emit({ type: 'counter.inc', actor: 'x', payload: { n: 3 } });
    store.emit({ type: 'counter.inc', actor: 'x', payload: { n: 2 } });

    const total = store.project(
      (state, event) => state + event.payload.n,
      { type: 'counter.inc' },
      0,
    );
    expect(total).toBe(6);
  });

  it('count returns correct count', () => {
    store.emit({ type: 'a', actor: 'x' });
    store.emit({ type: 'a', actor: 'x' });
    store.emit({ type: 'b', actor: 'x' });
    expect(store.count({ type: 'a' })).toBe(2);
    expect(store.count()).toBe(3);
  });

  it('emit rejects invalid envelope', () => {
    expect(() => store.emit({ actor: 'x' })).toThrow('type');
  });

  it('project reads all events beyond default limit', () => {
    for (let i = 0; i < 1100; i++) {
      store.emit({ type: 'counter.inc', actor: 'x', payload: { n: 1 } });
    }
    const total = store.project(
      (state, event) => state + event.payload.n,
      { type: 'counter.inc' },
      0,
    );
    expect(total).toBe(1100);
  });

  it('handles 1000 events efficiently', () => {
    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      store.emit({ type: 'perf.test', actor: 'bench', trace_id: `tr_${i % 10}`, payload: { i } });
    }
    const insertMs = Date.now() - start;

    const qStart = Date.now();
    const events = store.getEvents({ trace_id: 'tr_5' });
    const queryMs = Date.now() - qStart;

    expect(events).toHaveLength(100);
    expect(insertMs).toBeLessThan(5000); // generous for CI
    expect(queryMs).toBeLessThan(100);
  });
});
