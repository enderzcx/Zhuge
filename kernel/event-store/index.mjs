/**
 * Kernel Event Store — append-only event log.
 *
 * Role-agnostic: event types are strings defined by harness, kernel doesn't interpret.
 * Backend: SQLite (injected db instance).
 */

import { ulid, validateEnvelope, buildEnvelope } from './envelope.mjs';

/**
 * Initialize kernel_events table + prepared statements on a db instance.
 * Called once at startup. Idempotent.
 */
export function initEventStoreSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kernel_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      ts TEXT NOT NULL,
      actor TEXT NOT NULL,
      trace_id TEXT,
      parent_id TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ke_type_ts ON kernel_events(type, ts);
    CREATE INDEX IF NOT EXISTS idx_ke_trace ON kernel_events(trace_id);
    CREATE INDEX IF NOT EXISTS idx_ke_actor_ts ON kernel_events(actor, ts);
  `);
}

/**
 * Create an Event Store instance.
 *
 * @param {{ db: import('better-sqlite3').Database }} deps
 * @returns {EventStore}
 */
export function createEventStore({ db }) {
  initEventStoreSchema(db);

  const _insert = db.prepare(`
    INSERT INTO kernel_events (id, type, ts, actor, trace_id, parent_id, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  /**
   * Append an event to the store.
   * @param {object} event - at minimum { type, actor }; id/ts auto-filled
   * @returns {object} the complete event envelope (with generated id/ts)
   * @throws if validation fails
   */
  function emit(event) {
    const envelope = buildEnvelope(event);
    const { ok, errors } = validateEnvelope(envelope);
    if (!ok) {
      throw new Error(`Invalid event envelope: ${errors.join(', ')}`);
    }

    _insert.run(
      envelope.id,
      envelope.type,
      envelope.ts,
      envelope.actor,
      envelope.trace_id,
      envelope.parent_id,
      JSON.stringify(envelope.payload),
    );

    return envelope;
  }

  /**
   * Query events from the store.
   * @param {object} query
   * @param {string} [query.since] - ISO 8601 lower bound (inclusive)
   * @param {string} [query.until] - ISO 8601 upper bound (exclusive)
   * @param {string|string[]} [query.type] - filter by event type(s)
   * @param {string} [query.actor] - filter by actor
   * @param {string} [query.trace_id] - filter by trace_id
   * @param {number} [query.limit=1000] - max results
   * @param {'asc'|'desc'} [query.order='asc'] - sort by ts
   * @returns {object[]} array of event envelopes
   */
  function getEvents(query = {}) {
    const conditions = [];
    const params = [];

    if (query.since) {
      conditions.push('ts >= ?');
      params.push(query.since);
    }
    if (query.until) {
      conditions.push('ts < ?');
      params.push(query.until);
    }
    if (query.type) {
      const types = Array.isArray(query.type) ? query.type : [query.type];
      conditions.push(`type IN (${types.map(() => '?').join(',')})`);
      params.push(...types);
    }
    if (query.actor) {
      conditions.push('actor = ?');
      params.push(query.actor);
    }
    if (query.trace_id) {
      conditions.push('trace_id = ?');
      params.push(query.trace_id);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const order = query.order === 'desc' ? 'DESC' : 'ASC';
    const limit = query.limit === 0 ? null : (query.limit || 1000);

    const sql = limit
      ? `SELECT * FROM kernel_events ${where} ORDER BY ts ${order} LIMIT ?`
      : `SELECT * FROM kernel_events ${where} ORDER BY ts ${order}`;
    if (limit) params.push(limit);

    const rows = db.prepare(sql).all(...params);

    return rows.map(row => ({
      id: row.id,
      type: row.type,
      ts: row.ts,
      actor: row.actor,
      trace_id: row.trace_id,
      parent_id: row.parent_id,
      payload: JSON.parse(row.payload),
    }));
  }

  /**
   * Project events into a state via a reducer function.
   * @param {function} reducer - (state, event) => newState
   * @param {object} query - same as getEvents query
   * @param {*} [initial=null] - initial state
   * @returns {*} projected state
   */
  function project(reducer, query, initial = null) {
    const events = getEvents({ ...query, limit: query?.limit || 0 });
    return events.reduce(reducer, initial);
  }

  /**
   * Count events matching a query.
   * @param {object} query - same filters as getEvents (except limit/order)
   * @returns {number}
   */
  function count(query = {}) {
    const conditions = [];
    const params = [];

    if (query.since) { conditions.push('ts >= ?'); params.push(query.since); }
    if (query.until) { conditions.push('ts < ?'); params.push(query.until); }
    if (query.type) {
      const types = Array.isArray(query.type) ? query.type : [query.type];
      conditions.push(`type IN (${types.map(() => '?').join(',')})`);
      params.push(...types);
    }
    if (query.actor) { conditions.push('actor = ?'); params.push(query.actor); }
    if (query.trace_id) { conditions.push('trace_id = ?'); params.push(query.trace_id); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return db.prepare(`SELECT COUNT(*) as cnt FROM kernel_events ${where}`).get(...params).cnt;
  }

  return { emit, getEvents, project, count, ulid };
}
