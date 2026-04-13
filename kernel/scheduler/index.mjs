/**
 * Kernel Scheduler — unified task trigger mechanism.
 *
 * Supports: cron (periodic), event (event store subscription), manual trigger.
 * All tasks run in-process on the Node.js event loop.
 * Each execution emits lifecycle events to the event store.
 *
 * Not an OS process scheduler — just a task scheduler.
 */

import { ulid } from '../event-store/envelope.mjs';

/**
 * Simple cron expression parser (minute hour dom month dow).
 * Returns a function that checks if a Date matches.
 * Supports: *, N, N-M, * /N (step), comma-separated values.
 */
function parseCronField(field, min, max) {
  if (field === '*') return () => true;

  // Step: */N
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2));
    return (val) => val % step === 0;
  }

  // Range: N-M
  if (field.includes('-')) {
    const [lo, hi] = field.split('-').map(Number);
    return (val) => val >= lo && val <= hi;
  }

  // List: N,M,...
  if (field.includes(',')) {
    const vals = new Set(field.split(',').map(Number));
    return (val) => vals.has(val);
  }

  // Exact: N
  const exact = parseInt(field);
  return (val) => val === exact;
}

function parseCron(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Invalid cron expression: ${expr}`);

  const [minF, hourF, domF, monF, dowF] = [
    parseCronField(parts[0], 0, 59),
    parseCronField(parts[1], 0, 23),
    parseCronField(parts[2], 1, 31),
    parseCronField(parts[3], 1, 12),
    parseCronField(parts[4], 0, 6),
  ];

  return (date) => {
    return minF(date.getMinutes()) &&
      hourF(date.getHours()) &&
      domF(date.getDate()) &&
      monF(date.getMonth() + 1) &&
      dowF(date.getDay());
  };
}

/**
 * Create a Scheduler instance.
 * @param {{ eventStore?: import('../event-store/index.mjs').EventStore, log?: object }} deps
 * @returns {Scheduler}
 */
export function createScheduler({ eventStore, log } = {}) {
  const _log = log || { info() {}, warn() {}, error() {} };

  /** @type {Map<string, TaskDef>} name → task definition */
  const tasks = new Map();
  /** @type {Map<string, NodeJS.Timeout>} name → cron interval ID */
  const cronTimers = new Map();
  /** @type {Map<string, Set<string>>} name → set of running execution IDs */
  const running = new Map();
  /** @type {Map<string, Function>} subscriptionId → unsubscribe fn (for event triggers) */
  const eventSubs = new Map();

  let _cronCheckInterval = null;
  let _started = false;

  /**
   * Register a task.
   * @param {{
   *   name: string,
   *   trigger: { type: 'cron', expr: string } | { type: 'event', match: object } | { type: 'manual' },
   *   handler: function,
   *   concurrency?: number,
   *   timeout_ms?: number
   * }} def
   */
  function register(def) {
    if (!def.name) throw new Error('task name is required');
    if (!def.handler || typeof def.handler !== 'function') throw new Error('handler is required');
    if (!def.trigger) throw new Error('trigger is required');

    const task = {
      name: def.name,
      trigger: def.trigger,
      handler: def.handler,
      concurrency: def.concurrency || 1,
      timeout_ms: def.timeout_ms || 300000, // 5 min default
    };

    // Parse cron if applicable
    if (task.trigger.type === 'cron') {
      task._cronMatch = parseCron(task.trigger.expr);
    }

    tasks.set(def.name, task);
    running.set(def.name, new Set());
  }

  /**
   * Start the scheduler (enables cron checking + event subscriptions).
   * @param {{ cron_check_interval_ms?: number }} [opts]
   */
  function start(opts = {}) {
    if (_started) return;
    _started = true;

    // Cron check every 60s by default
    const interval = opts.cron_check_interval_ms || 60000;
    _cronCheckInterval = setInterval(() => _checkCron(), interval);

    // Set up event polling for event-triggered tasks
    if (eventStore) {
      const eventInterval = opts.event_poll_interval_ms || 5000;
      _eventPollInterval = setInterval(() => _checkEvents(), eventInterval);
    }
  }

  /** Track last polled event ID to avoid re-processing. */
  let _lastEventId = null;
  let _eventPollInterval = null;

  /**
   * Poll event store for new events matching event-triggered tasks.
   */
  function _checkEvents() {
    if (!eventStore) return;

    const eventTasks = [...tasks.values()].filter(t => t.trigger.type === 'event');
    if (eventTasks.length === 0) return;

    // Get all event types we care about
    const matchTypes = eventTasks.map(t => t.trigger.match?.type).filter(Boolean);
    if (matchTypes.length === 0) return;

    const query = { type: matchTypes };
    if (_lastEventTs) query.since = _lastEventTs;

    let events = eventStore.getEvents(query);

    // Skip already-processed events
    if (_lastEventId) {
      const idx = events.findIndex(e => e.id === _lastEventId);
      if (idx >= 0) events = events.slice(idx + 1);
    }

    if (events.length === 0) return;

    // Update cursor
    const lastEvent = events[events.length - 1];
    _lastEventTs = lastEvent.ts;
    _lastEventId = lastEvent.id;

    // Match events to tasks
    for (const event of events) {
      for (const task of eventTasks) {
        if (_matchesEventTrigger(task.trigger.match, event)) {
          _tryExecute(task.name, { trigger: 'event', event_type: event.type, event_id: event.id, payload: event.payload });
        }
      }
    }
  }

  let _lastEventTs = null;

  /**
   * Check if an event matches a trigger's match criteria.
   */
  function _matchesEventTrigger(match, event) {
    if (!match) return false;
    for (const [key, value] of Object.entries(match)) {
      if (event[key] !== value) return false;
    }
    return true;
  }

  /**
   * Stop the scheduler.
   */
  function stop() {
    if (_cronCheckInterval) {
      clearInterval(_cronCheckInterval);
      _cronCheckInterval = null;
    }
    if (_eventPollInterval) {
      clearInterval(_eventPollInterval);
      _eventPollInterval = null;
    }
    _started = false;
  }

  /**
   * Check and fire cron tasks.
   */
  function _checkCron() {
    const now = new Date();
    for (const [name, task] of tasks) {
      if (task.trigger.type !== 'cron') continue;
      if (task._cronMatch && task._cronMatch(now)) {
        _tryExecute(name, { trigger: 'cron', time: now.toISOString() });
      }
    }
  }

  /**
   * Manually trigger a task and wait for completion.
   * @param {string} name - task name
   * @param {object} [payload] - additional context
   * @returns {Promise<string>} executionId (after completion)
   */
  async function trigger(name, payload = {}) {
    const task = tasks.get(name);
    if (!task) throw new Error(`Unknown task: ${name}`);
    return _tryExecute(name, { trigger: 'manual', ...payload });
  }

  /**
   * Trigger a task without waiting. Returns executionId immediately.
   * @param {string} name
   * @param {object} [payload]
   * @returns {string|null} executionId (null if skipped due to concurrency)
   */
  function triggerAsync(name, payload = {}) {
    const task = tasks.get(name);
    if (!task) throw new Error(`Unknown task: ${name}`);

    const runningSet = running.get(name);
    if (runningSet.size >= task.concurrency) return null;

    const executionId = ulid();
    // Fire and forget — don't await
    _tryExecute(name, { trigger: 'manual', ...payload }).catch(() => {});
    return executionId;
  }

  /**
   * Execute a task with concurrency control.
   */
  async function _tryExecute(name, ctx) {
    const task = tasks.get(name);
    if (!task) return;

    const runningSet = running.get(name);
    if (runningSet.size >= task.concurrency) {
      _log.warn('scheduler_concurrency_skip', { task: name, running: runningSet.size });
      return null;
    }

    const executionId = ulid();
    runningSet.add(executionId);

    // Emit start event
    if (eventStore) {
      try {
        eventStore.emit({
          type: 'scheduler.task_started',
          actor: `scheduler:${name}`,
          trace_id: executionId,
          payload: { task: name, trigger: ctx.trigger },
        });
      } catch {}
    }

    const startMs = Date.now();

    try {
      // Execute with timeout (clear timer when done to prevent event loop leak)
      let timeoutHandle;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`Task '${name}' timed out after ${task.timeout_ms}ms`)), task.timeout_ms);
      });
      try {
        await Promise.race([task.handler({ ...ctx, execution_id: executionId }), timeoutPromise]);
      } finally {
        clearTimeout(timeoutHandle);
      }

      const durationMs = Date.now() - startMs;

      if (eventStore) {
        try {
          eventStore.emit({
            type: 'scheduler.task_completed',
            actor: `scheduler:${name}`,
            trace_id: executionId,
            payload: { task: name, duration_ms: durationMs },
          });
        } catch {}
      }
    } catch (err) {
      const durationMs = Date.now() - startMs;
      _log.error('scheduler_task_failed', { task: name, error: err.message, duration_ms: durationMs });

      if (eventStore) {
        try {
          eventStore.emit({
            type: 'scheduler.task_failed',
            actor: `scheduler:${name}`,
            trace_id: executionId,
            payload: { task: name, error: err.message, duration_ms: durationMs },
          });
        } catch {}
      }
    } finally {
      runningSet.delete(executionId);
    }

    return executionId;
  }

  /**
   * Cancel a running execution (best-effort — sets a flag, handler must check).
   * @param {string} executionId
   */
  function cancel(executionId) {
    // Sprint 3: no cooperative cancellation yet. Just remove from running set.
    for (const [, runningSet] of running) {
      runningSet.delete(executionId);
    }
  }

  /**
   * Get status of all registered tasks.
   * @returns {object[]}
   */
  function status() {
    return [...tasks.entries()].map(([name, task]) => ({
      name,
      trigger: task.trigger,
      concurrency: task.concurrency,
      running: running.get(name)?.size || 0,
      timeout_ms: task.timeout_ms,
    }));
  }

  /**
   * Check if a task is registered.
   */
  function has(name) { return tasks.has(name); }

  /**
   * Number of registered tasks.
   */
  function size() { return tasks.size; }

  return { register, start, stop, trigger, triggerAsync, cancel, status, has, size };
}
