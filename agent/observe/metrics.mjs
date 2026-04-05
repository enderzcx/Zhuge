/**
 * Lightweight time-series metrics — SQLite-backed, no external deps.
 * Records numeric metrics with optional JSON tags.
 * Auto-prunes entries older than 7 days every hour.
 */

const PRUNE_INTERVAL = 60 * 60 * 1000; // 1h
const RETENTION_DAYS = 7;

export function createMetrics(db) {
  // Schema (canonical definition in db.mjs, kept here for standalone usage)
  db.exec(`
    CREATE TABLE IF NOT EXISTS metrics (
      ts INTEGER NOT NULL,
      name TEXT NOT NULL,
      value REAL NOT NULL,
      tags TEXT DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_metrics_name_ts ON metrics(name, ts);
  `);

  const insertStmt = db.prepare(
    'INSERT INTO metrics (ts, name, value, tags) VALUES (?, ?, ?, ?)'
  );

  /**
   * Record a metric data point.
   * @param {string} name - e.g. 'llm_latency_ms', 'trade_pnl'
   * @param {number} value
   * @param {object} [tags] - e.g. { agent: 'analyst', model: 'gpt-5.4-mini' }
   */
  function record(name, value, tags = {}) {
    try {
      insertStmt.run(Date.now(), name, value, JSON.stringify(tags));
    } catch (e) {
      // Fail silently — metrics should never break the app
      if (!record._warned) {
        console.error('[metrics] Insert failed:', e.message);
        record._warned = true;
      }
    }
  }

  /**
   * Query metrics for a given name within a time range.
   * @param {string} name
   * @param {number} [sinceMs] - default: 24h ago
   * @param {number} [limit] - default: 1000
   * @returns {{ ts: number, value: number, tags: object }[]}
   */
  function query(name, sinceMs, limit = 1000) {
    const since = sinceMs || Date.now() - 24 * 60 * 60 * 1000;
    const rows = db.prepare(
      'SELECT ts, value, tags FROM metrics WHERE name = ? AND ts >= ? ORDER BY ts DESC LIMIT ?'
    ).all(name, since, limit);
    return rows.map(r => ({ ...r, tags: JSON.parse(r.tags || '{}') }));
  }

  /**
   * Get aggregated stats for a metric.
   * @param {string} name
   * @param {number} [sinceMs]
   * @returns {{ count: number, avg: number, min: number, max: number, sum: number }}
   */
  function stats(name, sinceMs) {
    const since = sinceMs || Date.now() - 24 * 60 * 60 * 1000;
    return db.prepare(`
      SELECT COUNT(*) as count, AVG(value) as avg, MIN(value) as min,
             MAX(value) as max, SUM(value) as sum
      FROM metrics WHERE name = ? AND ts >= ?
    `).get(name, since);
  }

  // Auto-prune old metrics
  let pruneTimer = null;
  function startPrune() {
    if (pruneTimer) return;
    pruneTimer = setInterval(() => {
      try {
        const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
        const result = db.prepare('DELETE FROM metrics WHERE ts < ?').run(cutoff);
        if (result.changes > 0) {
          console.log(`[metrics] Pruned ${result.changes} entries older than ${RETENTION_DAYS}d`);
        }
      } catch {}
    }, PRUNE_INTERVAL);
  }

  function stop() {
    if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
  }

  startPrune();

  return { record, query, stats, stop };
}
