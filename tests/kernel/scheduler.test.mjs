import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createScheduler } from '../../kernel/scheduler/index.mjs';
import { createEventStore } from '../../kernel/event-store/index.mjs';

describe('Scheduler', () => {
  let scheduler;
  let eventStore;

  beforeEach(() => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    eventStore = createEventStore({ db });
    scheduler = createScheduler({ eventStore });
  });

  describe('register', () => {
    it('registers a manual task', () => {
      scheduler.register({
        name: 'test.task',
        trigger: { type: 'manual' },
        handler: async () => {},
      });
      expect(scheduler.has('test.task')).toBe(true);
      expect(scheduler.size()).toBe(1);
    });

    it('registers a cron task', () => {
      scheduler.register({
        name: 'cron.task',
        trigger: { type: 'cron', expr: '*/5 * * * *' },
        handler: async () => {},
      });
      expect(scheduler.has('cron.task')).toBe(true);
    });

    it('rejects missing name', () => {
      expect(() => scheduler.register({ trigger: { type: 'manual' }, handler: async () => {} }))
        .toThrow('name');
    });

    it('rejects missing handler', () => {
      expect(() => scheduler.register({ name: 'x', trigger: { type: 'manual' } }))
        .toThrow('handler');
    });

    it('rejects invalid cron expression', () => {
      expect(() => scheduler.register({
        name: 'bad', trigger: { type: 'cron', expr: 'invalid' }, handler: async () => {},
      })).toThrow('Invalid cron');
    });
  });

  describe('trigger (manual)', () => {
    it('executes handler and returns execution ID', async () => {
      const fn = vi.fn(async () => {});
      scheduler.register({ name: 'task1', trigger: { type: 'manual' }, handler: fn });

      const execId = await scheduler.trigger('task1', { data: 'test' });
      expect(execId).toHaveLength(26); // ULID
      expect(fn).toHaveBeenCalledOnce();
      expect(fn.mock.calls[0][0].trigger).toBe('manual');
      expect(fn.mock.calls[0][0].data).toBe('test');
    });

    it('emits start + completed events', async () => {
      scheduler.register({ name: 'tracked', trigger: { type: 'manual' }, handler: async () => {} });
      await scheduler.trigger('tracked');

      const started = eventStore.getEvents({ type: 'scheduler.task_started' });
      const completed = eventStore.getEvents({ type: 'scheduler.task_completed' });
      expect(started).toHaveLength(1);
      expect(started[0].payload.task).toBe('tracked');
      expect(completed).toHaveLength(1);
      expect(completed[0].payload.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('emits failed event on handler error', async () => {
      scheduler.register({
        name: 'failing',
        trigger: { type: 'manual' },
        handler: async () => { throw new Error('boom'); },
      });

      await scheduler.trigger('failing');

      const failed = eventStore.getEvents({ type: 'scheduler.task_failed' });
      expect(failed).toHaveLength(1);
      expect(failed[0].payload.error).toBe('boom');
    });

    it('throws on unknown task', async () => {
      await expect(scheduler.trigger('nope')).rejects.toThrow('Unknown task');
    });
  });

  describe('concurrency', () => {
    it('respects concurrency limit', async () => {
      let resolveFirst;
      const firstPromise = new Promise(r => { resolveFirst = r; });

      scheduler.register({
        name: 'slow',
        trigger: { type: 'manual' },
        handler: async () => await firstPromise,
        concurrency: 1,
      });

      // Start first execution (will block)
      const p1 = scheduler.trigger('slow');

      // Second should be skipped
      const execId2 = await scheduler.trigger('slow');
      expect(execId2).toBeNull();

      // Clean up
      resolveFirst();
      await p1;
    });
  });

  describe('status', () => {
    it('returns registered tasks info', () => {
      scheduler.register({ name: 'a', trigger: { type: 'manual' }, handler: async () => {} });
      scheduler.register({ name: 'b', trigger: { type: 'cron', expr: '0 * * * *' }, handler: async () => {} });

      const s = scheduler.status();
      expect(s).toHaveLength(2);
      expect(s[0].name).toBe('a');
      expect(s[0].trigger.type).toBe('manual');
      expect(s[1].name).toBe('b');
      expect(s[1].trigger.type).toBe('cron');
    });
  });

  describe('timeout', () => {
    it('fails task on timeout', async () => {
      scheduler.register({
        name: 'slow_task',
        trigger: { type: 'manual' },
        handler: async () => new Promise(r => setTimeout(r, 5000)),
        timeout_ms: 50,
      });

      await scheduler.trigger('slow_task');

      const failed = eventStore.getEvents({ type: 'scheduler.task_failed' });
      expect(failed).toHaveLength(1);
      expect(failed[0].payload.error).toContain('timed out');
    });
  });
});
