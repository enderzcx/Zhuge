/**
 * Kernel Session — event-sourced conversation state.
 *
 * Each message is an event in the Event Store. getContext() is a projection.
 * No TTL pruning in kernel — harness decides retention policy.
 */

import { ulid } from '../event-store/envelope.mjs';

/**
 * Initialize kernel_sessions metadata table. Idempotent.
 */
export function initSessionSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kernel_sessions (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      metadata_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      archived INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ks_owner ON kernel_sessions(owner, archived);
  `);
}

/**
 * Create a Session manager.
 * @param {{ db: import('better-sqlite3').Database, eventStore: import('../event-store/index.mjs').EventStore }} deps
 * @returns {SessionManager}
 */
export function createSessionManager({ db, eventStore }) {
  initSessionSchema(db);

  const _insertSession = db.prepare(
    'INSERT INTO kernel_sessions (id, owner, metadata_json) VALUES (?, ?, ?)'
  );
  const _archiveSession = db.prepare(
    'UPDATE kernel_sessions SET archived = 1 WHERE id = ?'
  );
  const _getSession = db.prepare(
    'SELECT * FROM kernel_sessions WHERE id = ?'
  );

  /**
   * Create a new session.
   * @param {{ owner: string, metadata?: object }} opts
   * @returns {string} sessionId
   */
  function create({ owner, metadata = {} }) {
    if (!owner) throw new Error('owner is required');
    const sessionId = ulid();
    _insertSession.run(sessionId, owner, JSON.stringify(metadata));

    eventStore.emit({
      type: 'session.created',
      actor: `session:${owner}`,
      trace_id: sessionId,
      payload: { session_id: sessionId, owner, metadata },
    });

    return sessionId;
  }

  /**
   * Append a message to a session (stored as event).
   * @param {string} sessionId
   * @param {{ role: string, content?: string, tool_calls?: object[], tool_call_id?: string }} message
   */
  function append(sessionId, message) {
    if (!sessionId || !message || !message.role) {
      throw new Error('sessionId and message with role are required');
    }

    // Verify session exists
    const sess = _getSession.get(sessionId);
    if (!sess) throw new Error(`Session '${sessionId}' not found`);
    if (sess.archived) throw new Error(`Session '${sessionId}' is archived`);

    eventStore.emit({
      type: 'session.message',
      actor: `session:${sess.owner}`,
      trace_id: sessionId,
      payload: {
        session_id: sessionId,
        message: {
          role: message.role,
          content: message.content || null,
          tool_calls: message.tool_calls || null,
          tool_call_id: message.tool_call_id || null,
        },
      },
    });
  }

  /**
   * Get conversation context (messages) for a session.
   * Reconstructed from event store via projection.
   *
   * @param {string} sessionId
   * @param {{ recent_n?: number }} [opts]
   * @returns {object[]} messages in chronological order
   */
  function getContext(sessionId, opts = {}) {
    const recentN = opts.recent_n || 50;

    // Get all session.message events for this session
    const events = eventStore.getEvents({
      type: 'session.message',
      trace_id: sessionId,
      limit: 0, // no limit — project needs all
    });

    // Extract messages from events
    const messages = events
      .map(e => e.payload?.message)
      .filter(m => m && m.role);

    // Return last N messages
    if (messages.length > recentN) {
      return messages.slice(-recentN);
    }

    return messages;
  }

  /**
   * Archive a session (soft-delete).
   * @param {string} sessionId
   */
  function archive(sessionId) {
    _archiveSession.run(sessionId);

    eventStore.emit({
      type: 'session.archived',
      actor: 'session:system',
      trace_id: sessionId,
      payload: { session_id: sessionId },
    });
  }

  /**
   * List sessions.
   * @param {{ owner?: string, active_only?: boolean }} [filter]
   * @returns {object[]}
   */
  function list(filter = {}) {
    const conditions = [];
    const params = [];

    if (filter.owner) {
      conditions.push('owner = ?');
      params.push(filter.owner);
    }
    if (filter.active_only !== false) {
      conditions.push('archived = 0');
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT id, owner, metadata_json, created_at, archived FROM kernel_sessions ${where} ORDER BY created_at DESC`;

    return db.prepare(sql).all(...params).map(row => ({
      ...row,
      metadata: JSON.parse(row.metadata_json || '{}'),
    }));
  }

  /**
   * Get the number of messages in a session.
   * @param {string} sessionId
   * @returns {number}
   */
  function messageCount(sessionId) {
    return eventStore.count({
      type: 'session.message',
      trace_id: sessionId,
    });
  }

  return { create, append, getContext, archive, list, messageCount };
}
