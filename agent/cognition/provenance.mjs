/**
 * Decision provenance — full context snapshot at trade open, backfill at close.
 *
 * Pure engineering, no AI. Stores everything the agent knew when it made a decision,
 * so compound.mjs can later analyze patterns.
 *
 * Fields derived from actual trading data analysis (2026-04-05):
 *   momentum_score, funding_rate, volume_ratio, hour_utc, researcher_reasoning
 */

export function createProvenance({ db, log }) {
  const _log = log || { info() {}, warn() {}, error() {} };

  // Ensure tables exist (canonical definition in db.mjs, kept here for standalone usage)
  db.exec(`
    CREATE TABLE IF NOT EXISTS decision_provenance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id TEXT NOT NULL,
      trace_id TEXT,
      symbol TEXT,
      side TEXT,
      leverage INTEGER,
      entry_price REAL,
      momentum_score INTEGER,
      funding_rate REAL,
      volume_24h REAL,
      volume_ratio REAL,
      price_action_json TEXT,
      hour_utc INTEGER,
      researcher_reasoning TEXT,
      risk_verdict TEXT,
      active_rules_json TEXT,
      exit_price REAL,
      pnl REAL,
      pnl_pct REAL,
      hold_duration_min INTEGER,
      max_drawdown_pct REAL,
      created_at TEXT DEFAULT (datetime('now')),
      closed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_prov_trade ON decision_provenance(trade_id);
    CREATE INDEX IF NOT EXISTS idx_prov_symbol ON decision_provenance(symbol, created_at);
  `);

  const insertStmt = db.prepare(`
    INSERT INTO decision_provenance (
      trade_id, trace_id, symbol, side, leverage, entry_price,
      momentum_score, funding_rate, volume_24h, volume_ratio,
      price_action_json, hour_utc, researcher_reasoning, risk_verdict, active_rules_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const backfillStmt = db.prepare(`
    UPDATE decision_provenance
    SET exit_price = ?, pnl = ?, pnl_pct = ?, hold_duration_min = ?, max_drawdown_pct = ?, closed_at = ?
    WHERE trade_id = ?
  `);

  /**
   * Record decision context at trade open.
   * @param {object} ctx - all available context at decision time
   */
  function recordOpen(ctx) {
    try {
      // Load active compound rules to snapshot what rules were active
      let activeRules = '[]';
      try {
        const rules = db.prepare("SELECT rule_id, description FROM compound_rules WHERE status = 'active'").all();
        activeRules = JSON.stringify(rules);
      } catch {} // table may not exist yet

      insertStmt.run(
        ctx.trade_id || `trade_${Date.now()}`,
        ctx.trace_id || '',
        ctx.symbol || '',
        ctx.side || '',
        ctx.leverage || 10,
        ctx.entry_price || 0,
        ctx.momentum_score || 0,
        ctx.funding_rate || 0,
        ctx.volume_24h || 0,
        ctx.volume_ratio || 0,
        JSON.stringify(ctx.price_action || {}),
        ctx.hour_utc ?? new Date().getUTCHours(),
        (ctx.reasoning || '').slice(0, 2000),
        ctx.risk_verdict || '',
        activeRules,
      );
      _log.info('provenance_recorded', { module: 'provenance', symbol: ctx.symbol, side: ctx.side });
    } catch (err) {
      _log.error('provenance_record_failed', { module: 'provenance', error: err.message });
    }
  }

  /**
   * Backfill result when trade closes.
   */
  function recordClose(tradeId, result) {
    try {
      backfillStmt.run(
        result.exit_price || 0,
        result.pnl || 0,
        result.pnl_pct || 0,
        result.hold_duration_min || 0,
        result.max_drawdown_pct || 0,
        new Date().toISOString(),
        tradeId,
      );
      _log.info('provenance_closed', { module: 'provenance', tradeId, pnl: result.pnl });
    } catch (err) {
      _log.error('provenance_close_failed', { module: 'provenance', error: err.message });
    }
  }

  /**
   * Get full provenance for a trade (for TG "why did I lose" queries).
   */
  function getByTradeId(tradeId) {
    try {
      return db.prepare('SELECT * FROM decision_provenance WHERE trade_id = ?').get(tradeId) || null;
    } catch { return null; }
  }

  /**
   * Get recent closed trades with provenance (for compound.mjs).
   * @param {number} limit
   */
  function getRecentClosed(limit = 50) {
    try {
      return db.prepare(
        'SELECT * FROM decision_provenance WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT ?'
      ).all(limit);
    } catch { return []; }
  }

  /**
   * Count trades since last compound run.
   */
  function countSinceLastCompound() {
    try {
      const lastRun = db.prepare(
        'SELECT run_at FROM compound_runs ORDER BY run_at DESC LIMIT 1'
      ).get();
      if (!lastRun) {
        return db.prepare('SELECT COUNT(*) as c FROM decision_provenance WHERE closed_at IS NOT NULL').get()?.c || 0;
      }
      return db.prepare(
        'SELECT COUNT(*) as c FROM decision_provenance WHERE closed_at IS NOT NULL AND closed_at > ?'
      ).get(lastRun.run_at)?.c || 0;
    } catch { return 0; }
  }

  return { recordOpen, recordClose, getByTradeId, getRecentClosed, countSinceLastCompound };
}
