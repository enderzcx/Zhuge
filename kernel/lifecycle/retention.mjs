/**
 * Kernel Lifecycle / Retention — TTL + archival for kernel stores.
 *
 * Prevents SQLite from growing unbounded. Configurable per-scope policies.
 * Designed to be triggered by the scheduler (daily/weekly job).
 */

/**
 * Parse a duration string into milliseconds.
 * Supports: '30d', '90d', '180d', '1y', '7d', etc.
 * @param {string} duration
 * @returns {number} milliseconds
 */
function parseDuration(duration) {
  const match = duration.match(/^(\d+)(d|h|m|y)$/);
  if (!match) throw new Error(`Invalid duration: ${duration}`);
  const [, num, unit] = match;
  const n = parseInt(num);
  switch (unit) {
    case 'm': return n * 60 * 1000;
    case 'h': return n * 60 * 60 * 1000;
    case 'd': return n * 24 * 60 * 60 * 1000;
    case 'y': return n * 365 * 24 * 60 * 60 * 1000;
    default: throw new Error(`Unknown duration unit: ${unit}`);
  }
}

/**
 * Create a Lifecycle manager.
 * @param {{ db: import('better-sqlite3').Database, log?: object }} deps
 * @returns {Lifecycle}
 */
export function createLifecycle({ db, log }) {
  const _log = log || { info() {}, warn() {} };

  /** @type {Array<{ scope: string, retention: string, archive_to?: string, delete_after?: string }>} */
  const policies = [];

  /**
   * Register a retention policy.
   * @param {{
   *   scope: string,           // 'events:*' | 'events:capability.executed' | 'sessions' | 'memory:trader.context'
   *   retention: string,       // duration: '90d', '30d', '1y'
   *   archive_to?: string,     // 'archive' (default) or 'delete'
   *   delete_after?: string    // duration: delete archived data after this
   * }} policy
   */
  function addPolicy(policy) {
    if (!policy.scope || !policy.retention) {
      throw new Error('scope and retention are required');
    }
    parseDuration(policy.retention); // validate
    if (policy.delete_after) parseDuration(policy.delete_after);
    policies.push({ ...policy });
  }

  /**
   * Run all retention policies. Call this from a scheduled job.
   * @returns {{ scope: string, archived: number, deleted: number }[]}
   */
  function enforce() {
    const results = [];

    for (const policy of policies) {
      try {
        const result = _enforcePolicy(policy);
        results.push(result);
        if (result.archived > 0 || result.deleted > 0) {
          _log.info('lifecycle_enforce', result);
        }
      } catch (err) {
        _log.warn('lifecycle_enforce_error', { scope: policy.scope, error: err.message });
        results.push({ scope: policy.scope, archived: 0, deleted: 0, error: err.message });
      }
    }

    return results;
  }

  function _enforcePolicy(policy) {
    const retentionMs = parseDuration(policy.retention);
    const cutoff = new Date(Date.now() - retentionMs).toISOString();
    let archived = 0;
    let deleted = 0;

    // Events
    if (policy.scope.startsWith('events:')) {
      const eventType = policy.scope.slice(7); // after 'events:'

      if (policy.archive_to === 'delete' || !policy.archive_to) {
        // Direct delete (events are append-only, no archive flag)
        const where = eventType === '*'
          ? 'ts < ?'
          : 'ts < ? AND type = ?';
        const params = eventType === '*' ? [cutoff] : [cutoff, eventType];
        const result = db.prepare(`DELETE FROM kernel_events WHERE ${where}`).run(...params);
        deleted = result.changes;
      }
    }

    // Sessions
    if (policy.scope === 'sessions') {
      const result = db.prepare(
        'UPDATE kernel_sessions SET archived = 1 WHERE created_at < ? AND archived = 0'
      ).run(cutoff);
      archived = result.changes;

      // Delete archived sessions: delete_after counts from AFTER retention period
      // So total lifetime = retention + delete_after
      if (policy.delete_after) {
        const totalMs = retentionMs + parseDuration(policy.delete_after);
        const deleteCutoff = new Date(Date.now() - totalMs).toISOString();
        const del = db.prepare(
          'DELETE FROM kernel_sessions WHERE created_at < ? AND archived = 1'
        ).run(deleteCutoff);
        deleted = del.changes;
      }
    }

    // Memory
    if (policy.scope.startsWith('memory:')) {
      const memScope = policy.scope.slice(7);
      const where = memScope === '*'
        ? 'updated_at < ? AND archived = 0'
        : 'scope = ? AND updated_at < ? AND archived = 0';
      const params = memScope === '*' ? [cutoff] : [memScope, cutoff];

      const result = db.prepare(`UPDATE kernel_memories SET archived = 1 WHERE ${where}`).run(...params);
      archived = result.changes;

      // Delete archived: delete_after counts from AFTER retention period
      if (policy.delete_after) {
        const totalMs = retentionMs + parseDuration(policy.delete_after);
        const deleteCutoff = new Date(Date.now() - totalMs).toISOString();
        const delWhere = memScope === '*'
          ? 'updated_at < ? AND archived = 1'
          : 'scope = ? AND updated_at < ? AND archived = 1';
        const delParams = memScope === '*' ? [deleteCutoff] : [memScope, deleteCutoff];
        const del = db.prepare(`DELETE FROM kernel_memories WHERE ${delWhere}`).run(...delParams);
        deleted = del.changes;
      }
    }

    return { scope: policy.scope, archived, deleted };
  }

  /**
   * List all registered policies.
   * @returns {object[]}
   */
  function listPolicies() {
    return [...policies];
  }

  /**
   * Load default policies (sensible kernel defaults).
   */
  function loadDefaults() {
    addPolicy({ scope: 'events:*', retention: '90d', archive_to: 'delete' });
    addPolicy({ scope: 'sessions', retention: '30d', delete_after: '90d' });
    addPolicy({ scope: 'memory:*', retention: '180d' });
  }

  return { addPolicy, enforce, listPolicies, loadDefaults };
}
