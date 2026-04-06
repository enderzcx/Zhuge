/**
 * SQLite database: schema, prepared statements, and persist helpers.
 */

import { mkdirSync } from 'fs';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';

export function createDB() {
  mkdirSync('data', { recursive: true });
  const db = new Database('data/rifi.db');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS news (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      summary TEXT,
      source TEXT,
      link TEXT,
      score REAL,
      signal TEXT,
      link_hash TEXT UNIQUE,
      fetched_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL DEFAULT 'crypto',
      result_json TEXT,
      macro_risk_score INTEGER,
      crypto_sentiment INTEGER,
      stock_sentiment INTEGER,
      technical_bias TEXT,
      recommended_action TEXT,
      confidence INTEGER,
      push_worthy INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS patrol_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL DEFAULT 'crypto',
      report_text TEXT,
      period TEXT,
      scans INTEGER,
      risk_range TEXT,
      sentiment_range TEXT,
      trades_executed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id TEXT UNIQUE,
      source TEXT DEFAULT 'onchain',
      pair TEXT,
      side TEXT,
      entry_price REAL,
      exit_price REAL,
      amount REAL,
      amount_out REAL,
      leverage INTEGER DEFAULT 1,
      pnl REAL,
      pnl_pct REAL,
      fee REAL DEFAULT 0,
      status TEXT DEFAULT 'open',
      tx_hash TEXT,
      signal_snapshot TEXT,
      decision_reasoning TEXT,
      opened_at TEXT DEFAULT (datetime('now')),
      closed_at TEXT
    );
    -- Migration: add leverage column if upgrading from older schema
    CREATE INDEX IF NOT EXISTS idx_trades_source ON trades(source, status);
    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT (datetime('now')),
      agent TEXT DEFAULT 'sentinel',
      action TEXT,
      tool_name TEXT,
      tool_args TEXT,
      tool_result TEXT,
      input_summary TEXT,
      output_summary TEXT,
      reasoning TEXT,
      confidence INTEGER,
      result_eval TEXT DEFAULT 'pending',
      trade_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_news_fetched ON news(fetched_at);
    CREATE INDEX IF NOT EXISTS idx_analysis_mode ON analysis(mode, created_at);
    CREATE INDEX IF NOT EXISTS idx_patrol_mode ON patrol_reports(mode, created_at);
    CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status, opened_at);
    CREATE INDEX IF NOT EXISTS idx_trades_id ON trades(trade_id);
    CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(timestamp);
    CREATE INDEX IF NOT EXISTS idx_decisions_trade ON decisions(trade_id);

    CREATE TABLE IF NOT EXISTS agent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT,
      from_agent TEXT,
      to_agent TEXT,
      type TEXT,
      payload TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agent_msg_trace ON agent_messages(trace_id);

    CREATE TABLE IF NOT EXISTS strategies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal TEXT,
      template TEXT DEFAULT 'custom',
      plan_json TEXT,
      params_json TEXT,
      status TEXT DEFAULT 'active',
      progress_pct REAL DEFAULT 0,
      score INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_strategies_status ON strategies(status);

    CREATE TABLE IF NOT EXISTS candles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pair TEXT NOT NULL,
      open REAL,
      high REAL,
      low REAL,
      close REAL,
      ts_start TEXT NOT NULL,
      UNIQUE(pair, ts_start)
    );
    CREATE INDEX IF NOT EXISTS idx_candles_pair_ts ON candles(pair, ts_start);

    CREATE TABLE IF NOT EXISTS signal_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      analysis_id INTEGER NOT NULL UNIQUE,
      recommended_action TEXT,
      confidence INTEGER,
      price_at_signal REAL,
      price_15m REAL,
      price_1h REAL,
      price_4h REAL,
      correct_15m INTEGER,
      correct_1h INTEGER,
      correct_4h INTEGER,
      scored_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_signal_scores_action ON signal_scores(recommended_action);

    CREATE TABLE IF NOT EXISTS lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT DEFAULT 'reviewer',
      lesson TEXT NOT NULL,
      category TEXT,
      confidence INTEGER DEFAULT 50,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_lessons_active ON lessons(active, created_at);

    CREATE TABLE IF NOT EXISTS source_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_name TEXT NOT NULL,
      period TEXT NOT NULL,
      total_signals INTEGER DEFAULT 0,
      correct_signals INTEGER DEFAULT 0,
      accuracy REAL DEFAULT 0,
      weight REAL DEFAULT 1.0,
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(source_name, period)
    );

    -- Graduated position scaling: group of up to 4 levels
    CREATE TABLE IF NOT EXISTS position_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      current_level INTEGER DEFAULT 0,
      avg_entry_price REAL DEFAULT 0,
      total_size REAL DEFAULT 0,
      max_kelly_size REAL DEFAULT 0,
      stop_loss REAL,
      take_profit REAL,
      status TEXT DEFAULT 'active',
      opened_at TEXT DEFAULT (datetime('now')),
      closed_at TEXT,
      pnl REAL,
      pnl_pct REAL
    );
    CREATE INDEX IF NOT EXISTS idx_pg_status ON position_groups(status, symbol);

    -- Individual level entries within a position group
    CREATE TABLE IF NOT EXISTS position_levels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL REFERENCES position_groups(id),
      level INTEGER NOT NULL,
      trade_id TEXT,
      order_id TEXT,
      size REAL NOT NULL,
      entry_price REAL,
      confidence INTEGER,
      signal_action TEXT,
      opened_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pl_group ON position_levels(group_id);

    -- Momentum: coin discovery and research tracking
    CREATE TABLE IF NOT EXISTS coin_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      discovery_type TEXT DEFAULT 'new_listing',
      volume_24h REAL,
      change_24h REAL,
      price REAL,
      funding_rate REAL,
      research_score INTEGER,
      research_verdict TEXT,
      research_json TEXT,
      discovered_at TEXT DEFAULT (datetime('now')),
      researched_at TEXT,
      traded INTEGER DEFAULT 0,
      UNIQUE(symbol, discovered_at)
    );
    CREATE INDEX IF NOT EXISTS idx_cc_symbol ON coin_candidates(symbol, discovered_at);

    -- Push history: AI-analyzed push events with full context
    CREATE TABLE IF NOT EXISTS push_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      push_id TEXT UNIQUE,
      level TEXT NOT NULL,
      text TEXT NOT NULL,
      url TEXT,
      analysis_json TEXT,
      raw_news_json TEXT,
      reasoning TEXT,
      trace_id TEXT,
      pushed_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_push_ts ON push_history(pushed_at);

    -- Metrics: time-series observability (agent/observe/metrics.mjs)
    CREATE TABLE IF NOT EXISTS metrics (
      ts INTEGER NOT NULL,
      name TEXT NOT NULL,
      value REAL NOT NULL,
      tags TEXT DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_metrics_name_ts ON metrics(name, ts);

    -- Decision provenance: full trade context snapshot (agent/cognition/provenance.mjs)
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

    -- Compound strategies: AI-generated full trading strategies (Phase 3)
    CREATE TABLE IF NOT EXISTS compound_strategies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      direction TEXT NOT NULL DEFAULT 'long',
      symbols TEXT NOT NULL DEFAULT '[]',
      timeframe TEXT DEFAULT 'any',
      entry_conditions TEXT NOT NULL DEFAULT '[]',
      exit_conditions TEXT NOT NULL DEFAULT '[]',
      sizing_json TEXT NOT NULL DEFAULT '{}',
      risk_params_json TEXT DEFAULT '{}',
      status TEXT DEFAULT 'proposed',
      confidence REAL DEFAULT 0.5,
      evidence_json TEXT DEFAULT '{}',
      source_compound_run INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      activated_at TEXT,
      retired_at TEXT,
      retired_reason TEXT,
      superseded_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cs_status ON compound_strategies(status);

    -- Compound rules: AI-discovered trading patterns (agent/cognition/compound.mjs)
    CREATE TABLE IF NOT EXISTS compound_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id TEXT UNIQUE,
      description TEXT NOT NULL,
      action TEXT,
      evidence_trade_ids TEXT,
      trade_count INTEGER,
      confidence REAL DEFAULT 0,
      status TEXT DEFAULT 'active',
      param_changes_json TEXT DEFAULT '{}',
      source_compound_id INTEGER,
      discovered_at TEXT DEFAULT (datetime('now')),
      superseded_at TEXT,
      superseded_by TEXT
    );
    CREATE TABLE IF NOT EXISTS compound_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trades_reviewed INTEGER,
      rules_generated INTEGER,
      rules_updated INTEGER,
      rules_deprecated INTEGER,
      llm_reasoning TEXT,
      run_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const insertNews = db.prepare(`
    INSERT OR IGNORE INTO news (title, summary, source, link, score, signal, link_hash, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAnalysis = db.prepare(`
    INSERT INTO analysis (mode, result_json, macro_risk_score, crypto_sentiment, stock_sentiment, technical_bias, recommended_action, confidence, push_worthy, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // Migrations for existing DBs
  try { db.exec('ALTER TABLE trades ADD COLUMN leverage INTEGER DEFAULT 1'); } catch {}
  try { db.exec('ALTER TABLE trades ADD COLUMN strategy_id TEXT'); } catch {}

  const insertTrade = db.prepare(`
    INSERT INTO trades (trade_id, source, pair, side, entry_price, amount, amount_out, leverage, status, tx_hash, signal_snapshot, decision_reasoning, opened_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateTradeClose = db.prepare(`
    UPDATE trades SET exit_price = ?, pnl = ?, pnl_pct = ?, status = 'closed', closed_at = ? WHERE trade_id = ?
  `);
  const insertDecision = db.prepare(`
    INSERT INTO decisions (timestamp, agent, action, tool_name, tool_args, tool_result, input_summary, output_summary, reasoning, confidence, trade_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPatrol = db.prepare(`
    INSERT INTO patrol_reports (mode, report_text, period, scans, risk_range, sentiment_range, trades_executed, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertCandle = db.prepare(`
    INSERT OR REPLACE INTO candles (pair, open, high, low, close, ts_start)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertSignalScore = db.prepare(`
    INSERT OR IGNORE INTO signal_scores (analysis_id, recommended_action, confidence, price_at_signal, price_15m, price_1h, price_4h, correct_15m, correct_1h, correct_4h)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // --- Position group helpers ---
  const insertPositionGroup = db.prepare(`
    INSERT INTO position_groups (symbol, side, current_level, avg_entry_price, total_size, max_kelly_size, stop_loss, take_profit)
    VALUES (?, ?, 0, ?, ?, ?, ?, ?)
  `);
  const insertPositionLevel = db.prepare(`
    INSERT INTO position_levels (group_id, level, trade_id, order_id, size, entry_price, confidence, signal_action)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updatePositionGroup = db.prepare(`
    UPDATE position_groups SET current_level = ?, avg_entry_price = ?, total_size = ?, stop_loss = ?, take_profit = ? WHERE id = ?
  `);
  const closePositionGroup = db.prepare(`
    UPDATE position_groups SET status = ?, closed_at = datetime('now'), pnl = ?, pnl_pct = ? WHERE id = ?
  `);

  function getActiveGroup(symbol) {
    return db.prepare(`SELECT * FROM position_groups WHERE symbol = ? AND status = 'active' LIMIT 1`).get(symbol) || null;
  }
  function getGroupLevels(groupId) {
    return db.prepare(`SELECT * FROM position_levels WHERE group_id = ? ORDER BY level`).all(groupId);
  }
  function getLastAbandonedTime(symbol) {
    const row = db.prepare(`SELECT closed_at FROM position_groups WHERE symbol = ? AND status = 'abandoned' ORDER BY closed_at DESC LIMIT 1`).get(symbol);
    return row ? new Date(row.closed_at + 'Z').getTime() : 0;
  }
  function getAllActiveGroups() {
    return db.prepare(`SELECT * FROM position_groups WHERE status = 'active'`).all();
  }

  function persistNews(newsArr) {
    const now = new Date().toISOString();
    const insert = db.transaction((items) => {
      for (const n of items) {
        const link = n.link || n.url || '';
        const hash = link ? createHash('md5').update(link).digest('hex') : createHash('md5').update(n.title || '' + n.source || '').digest('hex');
        insertNews.run(
          n.title || n.headline || '',
          n.summary || n.description || '',
          n.source || '',
          link,
          n.score || n.aiRating?.score || 0,
          n.signal || n.aiRating?.signal || 'neutral',
          hash,
          now
        );
      }
    });
    try { insert(newsArr); } catch (e) { console.error('[DB] News insert error:', e.message); }
  }

  function persistAnalysis(mode, parsed, now) {
    try {
      insertAnalysis.run(
        mode,
        JSON.stringify(parsed),
        parsed.macro_risk_score || 0,
        parsed.crypto_sentiment || 0,
        parsed.stock_sentiment || 0,
        parsed.technical_bias || 'neutral',
        parsed.recommended_action || 'hold',
        parsed.confidence || 0,
        parsed.push_worthy ? 1 : 0,
        now
      );
    } catch (e) { console.error('[DB] Analysis insert error:', e.message); }
  }

  function persistPatrol(mode, report, period, scans, riskRange, sentRange, trades, now) {
    try {
      insertPatrol.run(mode, report, period, scans, riskRange, sentRange, trades, now);
    } catch (e) { console.error('[DB] Patrol insert error:', e.message); }
  }

  const insertCandidate = db.prepare(`
    INSERT OR IGNORE INTO coin_candidates (symbol, discovery_type, volume_24h, change_24h, price, funding_rate, discovered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const updateCandidateResearch = db.prepare(`
    UPDATE coin_candidates SET research_score = ?, research_verdict = ?, research_json = ?, researched_at = ? WHERE id = ?
  `);
  const markCandidateTraded = db.prepare(`UPDATE coin_candidates SET traded = 1 WHERE id = ?`);

  // --- Compound strategies ---
  const insertCompoundStrategy = db.prepare(`
    INSERT INTO compound_strategies (strategy_id, name, description, direction, symbols, timeframe, entry_conditions, exit_conditions, sizing_json, risk_params_json, status, confidence, source_compound_run)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(strategy_id) DO UPDATE SET
      name = excluded.name, description = excluded.description, direction = excluded.direction,
      symbols = excluded.symbols, entry_conditions = excluded.entry_conditions,
      exit_conditions = excluded.exit_conditions, sizing_json = excluded.sizing_json,
      risk_params_json = excluded.risk_params_json, status = excluded.status,
      confidence = excluded.confidence, source_compound_run = excluded.source_compound_run
  `);
  const updateCompoundStrategyStatus = db.prepare(`
    UPDATE compound_strategies SET status = ?, activated_at = CASE WHEN ? = 'active' THEN datetime('now') ELSE activated_at END,
    retired_at = CASE WHEN ? = 'retired' THEN datetime('now') ELSE retired_at END, retired_reason = ? WHERE strategy_id = ?
  `);
  const updateCompoundStrategyEvidence = db.prepare(`
    UPDATE compound_strategies SET evidence_json = ? WHERE strategy_id = ?
  `);

  const insertPush = db.prepare(`
    INSERT INTO push_history (push_id, level, text, url, analysis_json, raw_news_json, reasoning, trace_id, pushed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Proxy prepare/exec so modules can call db.prepare() directly
  return {
    db,
    prepare: (...args) => db.prepare(...args),
    exec: (...args) => db.exec(...args),
    insertNews, insertAnalysis, insertTrade, updateTradeClose,
    insertDecision, insertPatrol, insertCandle, insertSignalScore,
    insertPositionGroup, insertPositionLevel, updatePositionGroup, closePositionGroup,
    getActiveGroup, getGroupLevels, getLastAbandonedTime, getAllActiveGroups,
    persistNews, persistAnalysis, persistPatrol,
    insertCandidate, updateCandidateResearch, markCandidateTraded,
    insertCompoundStrategy, updateCompoundStrategyStatus, updateCompoundStrategyEvidence,
    insertPush,
  };
}
