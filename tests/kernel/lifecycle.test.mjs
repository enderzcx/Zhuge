import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createLifecycle } from '../../kernel/lifecycle/retention.mjs';
import { createEventStore } from '../../kernel/event-store/index.mjs';
import { createMemory } from '../../kernel/memory/index.mjs';
import { createSessionManager } from '../../kernel/session/index.mjs';

describe('Lifecycle', () => {
  let db;
  let lifecycle;
  let eventStore;
  let memory;
  let session;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    eventStore = createEventStore({ db });
    memory = createMemory({ db });
    session = createSessionManager({ db, eventStore });
    lifecycle = createLifecycle({ db });
  });

  describe('addPolicy', () => {
    it('accepts valid policy', () => {
      lifecycle.addPolicy({ scope: 'events:*', retention: '90d' });
      expect(lifecycle.listPolicies()).toHaveLength(1);
    });

    it('rejects invalid duration', () => {
      expect(() => lifecycle.addPolicy({ scope: 'events:*', retention: 'invalid' }))
        .toThrow('Invalid duration');
    });

    it('rejects missing fields', () => {
      expect(() => lifecycle.addPolicy({ retention: '30d' })).toThrow('scope');
    });
  });

  describe('enforce events', () => {
    it('deletes old events', () => {
      // Insert events with old timestamps
      eventStore.emit({ type: 'old.event', actor: 'test', ts: '2020-01-01T00:00:00Z', payload: {} });
      eventStore.emit({ type: 'old.event', actor: 'test', ts: '2020-06-01T00:00:00Z', payload: {} });
      eventStore.emit({ type: 'new.event', actor: 'test', payload: {} }); // now

      lifecycle.addPolicy({ scope: 'events:*', retention: '30d', archive_to: 'delete' });
      const [result] = lifecycle.enforce();

      expect(result.deleted).toBe(2);
      expect(eventStore.count()).toBe(1); // only 'new.event' remains
    });

    it('deletes only matching event type', () => {
      eventStore.emit({ type: 'keep.me', actor: 'test', ts: '2020-01-01T00:00:00Z', payload: {} });
      eventStore.emit({ type: 'delete.me', actor: 'test', ts: '2020-01-01T00:00:00Z', payload: {} });

      lifecycle.addPolicy({ scope: 'events:delete.me', retention: '30d', archive_to: 'delete' });
      lifecycle.enforce();

      expect(eventStore.count({ type: 'keep.me' })).toBe(1);
      expect(eventStore.count({ type: 'delete.me' })).toBe(0);
    });
  });

  describe('enforce sessions', () => {
    it('archives old sessions', () => {
      // Create sessions — they'll have current timestamps
      // We need old sessions, so insert directly
      db.prepare("INSERT INTO kernel_sessions (id, owner, created_at) VALUES (?, ?, ?)")
        .run('old-session', 'trader', '2020-01-01T00:00:00Z');
      session.create({ owner: 'trader' }); // new session

      lifecycle.addPolicy({ scope: 'sessions', retention: '30d' });
      const [result] = lifecycle.enforce();

      expect(result.archived).toBe(1);
      const active = session.list({ active_only: true });
      expect(active).toHaveLength(1); // only new session
    });
  });

  describe('enforce memory', () => {
    it('archives old memories', () => {
      memory.write({ scope: 'trader.context', content: 'old data', ts: '2020-01-01T00:00:00Z' });
      memory.write({ scope: 'trader.context', content: 'fresh data' });

      lifecycle.addPolicy({ scope: 'memory:trader.context', retention: '30d' });
      const [result] = lifecycle.enforce();

      expect(result.archived).toBe(1);
      expect(memory.read('trader.context')).toHaveLength(1);
      expect(memory.read('trader.context')[0].content).toBe('fresh data');
    });
  });

  describe('loadDefaults', () => {
    it('loads 3 default policies', () => {
      lifecycle.loadDefaults();
      expect(lifecycle.listPolicies()).toHaveLength(3);
    });
  });
});
