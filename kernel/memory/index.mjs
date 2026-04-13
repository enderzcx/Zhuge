/**
 * Kernel Memory API — role-agnostic persistent memory with keyword recall.
 *
 * Backend: SQLite. Harness-isolated via scope namespacing.
 * Recall uses recency-weighted keyword matching (no vector search).
 */

import { ulid } from '../event-store/envelope.mjs';

/**
 * Initialize kernel_memories table. Idempotent.
 */
export function initMemorySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kernel_memories (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      key TEXT,
      content TEXT NOT NULL,
      type TEXT DEFAULT 'note',
      importance REAL DEFAULT 0.5,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      archived INTEGER DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_km_scope_key ON kernel_memories(scope, key);
    CREATE INDEX IF NOT EXISTS idx_km_scope ON kernel_memories(scope, archived);
    CREATE INDEX IF NOT EXISTS idx_km_type ON kernel_memories(type, archived);
  `);
}

/**
 * Extract keyword tokens from text for recall matching.
 * Handles both CJK and Latin text.
 * @param {string} text
 * @returns {string[]}
 */
function extractTokens(text) {
  if (!text) return [];
  const tokens = new Set();

  // Latin words (2+ chars)
  const words = text.toLowerCase().match(/[a-z0-9]{2,}/g) || [];
  for (const w of words) tokens.add(w);

  // CJK character bigrams
  const cjk = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || [];
  for (let i = 0; i < cjk.length - 1; i++) {
    tokens.add(cjk[i] + cjk[i + 1]);
  }
  // Single CJK chars too (for short queries)
  for (const c of cjk) tokens.add(c);

  return [...tokens];
}

/**
 * Create a Memory API instance.
 * @param {{ db: import('better-sqlite3').Database }} deps
 * @returns {MemoryAPI}
 */
export function createMemory({ db }) {
  initMemorySchema(db);

  const _insert = db.prepare(`
    INSERT INTO kernel_memories (id, scope, key, content, type, importance, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const _findByKey = db.prepare(
    'SELECT id FROM kernel_memories WHERE scope = ? AND key = ?'
  );
  const _updateByKey = db.prepare(`
    UPDATE kernel_memories SET content = ?, type = ?, importance = ?, updated_at = ?, archived = 0
    WHERE scope = ? AND key = ?
  `);

  const _deleteById = db.prepare('DELETE FROM kernel_memories WHERE id = ?');

  /**
   * Write a memory entry.
   * If `key` is provided and exists in scope, updates it (upsert).
   * @param {{ scope: string, key?: string, content: string, type?: string, importance?: number, ts?: string }} entry
   * @returns {string} memoryId
   */
  function write({ scope, key, content, type = 'note', importance = 0.5, ts }) {
    if (!scope || !content) throw new Error('scope and content are required');

    const now = ts || new Date().toISOString();
    const id = ulid();

    if (key) {
      // Upsert by scope+key: check if exists, then update or insert
      const existing = _findByKey.get(scope, key);
      if (existing) {
        _updateByKey.run(content, type, importance, now, scope, key);
        return existing.id;
      }
      _insert.run(id, scope, key, content, type, importance, now, now);
    } else {
      _insert.run(id, scope, null, content, type, importance, now, now);
    }

    return id;
  }

  /**
   * Read memories from a scope.
   * @param {string} scope
   * @param {{ type?: string, key?: string, limit?: number, include_archived?: boolean }} [opts]
   * @returns {object[]}
   */
  function read(scope, opts = {}) {
    const conditions = ['scope = ?'];
    const params = [scope];

    if (!opts.include_archived) {
      conditions.push('archived = 0');
    }
    if (opts.type) {
      conditions.push('type = ?');
      params.push(opts.type);
    }
    if (opts.key) {
      conditions.push('key = ?');
      params.push(opts.key);
    }

    const limit = opts.limit || 100;
    const sql = `SELECT * FROM kernel_memories WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`;
    params.push(limit);

    return db.prepare(sql).all(...params);
  }

  /**
   * Recall memories matching a query (keyword-based, recency-weighted).
   * Searches across scopes unless scope filter is specified.
   * @param {string} query
   * @param {{ scope?: string, limit?: number }} [opts]
   * @returns {object[]} ranked results
   */
  function recall(query, opts = {}) {
    if (!query) return [];

    const queryTokens = extractTokens(query);
    if (queryTokens.length === 0) return [];

    // Fetch candidates
    const conditions = ['archived = 0'];
    const params = [];
    if (opts.scope) {
      conditions.push('scope = ?');
      params.push(opts.scope);
    }

    const sql = `SELECT * FROM kernel_memories WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC LIMIT 200`;
    const candidates = db.prepare(sql).all(...params);

    // Score each candidate
    const scored = candidates.map(mem => {
      const memTokens = extractTokens(mem.content + ' ' + (mem.key || ''));
      const memSet = new Set(memTokens);

      // Term match score
      let matches = 0;
      for (const qt of queryTokens) {
        if (memSet.has(qt)) matches++;
      }
      const termScore = queryTokens.length > 0 ? matches / queryTokens.length : 0;

      // Recency score (decay over 10 days)
      const ageMs = Date.now() - new Date(mem.updated_at).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      const recencyScore = Math.max(0, 1.5 - ageDays / 10);

      // Combined — require at least some term overlap
      const score = termScore > 0
        ? recencyScore * 0.3 + termScore * 0.7 + (mem.importance || 0.5) * 0.1
        : 0; // No term match → score 0, will be filtered out

      return { ...mem, _score: score };
    });

    // Filter and sort
    const threshold = 0.15;
    const limit = opts.limit || 10;

    return scored
      .filter(m => m._score >= threshold)
      .sort((a, b) => b._score - a._score)
      .slice(0, limit);
  }

  /**
   * Delete a memory by ID.
   * @param {string} id
   * @returns {boolean} true if deleted
   */
  function del(id) {
    const result = _deleteById.run(id);
    return result.changes > 0;
  }

  /**
   * Archive memories in a scope older than a timestamp.
   * @param {string} scope
   * @param {string} before_ts - ISO 8601
   * @returns {number} count of archived entries
   */
  function archive(scope, before_ts) {
    const result = db.prepare(
      'UPDATE kernel_memories SET archived = 1 WHERE scope = ? AND updated_at < ? AND archived = 0'
    ).run(scope, before_ts);
    return result.changes;
  }

  return { write, read, recall, delete: del, archive };
}
