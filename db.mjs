/**
 * SQLite database: schema, prepared statements, and persist helpers.
 */

import { mkdirSync } from 'fs';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';

export function createDB({ log } = {}) {
  const _log = log || { warn: (msg, ctx) => console.error(`[DB] ${msg}`, ctx?.error || '') };
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
      family_id TEXT,
      version_id TEXT,
      role TEXT,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      direction TEXT NOT NULL DEFAULT 'long',
      symbols TEXT NOT NULL DEFAULT '[]',
      timeframe TEXT DEFAULT 'any',
      entry_conditions TEXT NOT NULL DEFAULT '[]',
      exit_conditions TEXT NOT NULL DEFAULT '[]',
      sizing_json TEXT NOT NULL DEFAULT '{}',
      risk_params_json TEXT DEFAULT '{}',
      target_json TEXT DEFAULT '{}',
      execution_json TEXT DEFAULT '{}',
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
      family_id TEXT,
      version_id TEXT,
      scope TEXT DEFAULT 'global',
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
    -- Backtest candles: historical data for strategy validation
    CREATE TABLE IF NOT EXISTS backtest_candles (
      pair TEXT NOT NULL,
      timeframe TEXT NOT NULL DEFAULT '1H',
      ts INTEGER NOT NULL,
      open REAL, high REAL, low REAL, close REAL, volume REAL,
      UNIQUE(pair, timeframe, ts)
    );
    CREATE INDEX IF NOT EXISTS idx_bt_candles ON backtest_candles(pair, timeframe, ts);

    -- Intel Stream: unified news/social/announcement items
    CREATE TABLE IF NOT EXISTS intel_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      source TEXT,
      link TEXT,
      score INTEGER DEFAULT 0,
      signal TEXT DEFAULT 'neutral',
      coins TEXT,
      category TEXT,
      origin TEXT,
      hash TEXT UNIQUE,
      triggered INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_intel_score ON intel_items(score);
    CREATE INDEX IF NOT EXISTS idx_intel_created ON intel_items(created_at);

    -- Conversation history: persists TG agent chat across restarts
    CREATE TABLE IF NOT EXISTS conversation_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_calls TEXT,
      tool_call_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_conv_hist ON conversation_history(conversation_id, created_at);

    -- Scheduled tasks: agent-managed recurring jobs
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      enabled INTEGER DEFAULT 1,
      schedule_type TEXT NOT NULL,
      interval_ms INTEGER,
      daily_hour INTEGER,
      daily_minute INTEGER DEFAULT 0,
      action TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      last_run_at TEXT,
      next_run_at TEXT,
      run_count INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      last_error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sched_next ON scheduled_tasks(enabled, next_run_at);

    CREATE TABLE IF NOT EXISTS scheduled_task_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      status TEXT DEFAULT 'success',
      duration_ms INTEGER,
      result_summary TEXT,
      error_message TEXT,
      run_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sched_runs ON scheduled_task_runs(task_id, run_at);

    -- Memory backup: critical memory files backed up to SQLite
    CREATE TABLE IF NOT EXISTS memory_backup (
      key TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Dream runs: memory consolidation history
    CREATE TABLE IF NOT EXISTS dream_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      notes_reviewed INTEGER DEFAULT 0,
      merged INTEGER DEFAULT 0,
      deleted INTEGER DEFAULT 0,
      created INTEGER DEFAULT 0,
      summary TEXT,
      backup_json TEXT,
      run_at TEXT DEFAULT (datetime('now'))
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

    CREATE TABLE IF NOT EXISTS strategy_families (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      family_id TEXT UNIQUE NOT NULL,
      family_name TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_strategy_families_status ON strategy_families(status, family_id);

    CREATE TABLE IF NOT EXISTS strategy_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version_id TEXT UNIQUE NOT NULL,
      family_id TEXT NOT NULL,
      version_name TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      is_live INTEGER DEFAULT 0,
      decision_mode TEXT DEFAULT 'trigger',
      rollout_mode TEXT DEFAULT 'live',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      activated_at TEXT,
      retired_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_strategy_versions_family_status ON strategy_versions(family_id, status, is_live);

    CREATE TABLE IF NOT EXISTS strategy_selector_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL DEFAULT 'global' UNIQUE,
      selected_family_id TEXT,
      selected_version_id TEXT,
      selection_mode TEXT DEFAULT 'manual',
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS market_state_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pair TEXT NOT NULL,
      timeframe TEXT NOT NULL DEFAULT '1H',
      ts INTEGER NOT NULL,
      mark_price REAL,
      index_price REAL,
      open_interest REAL,
      funding_rate REAL,
      basis_bps REAL,
      oi_change_24h REAL,
      source TEXT DEFAULT 'bitget',
      UNIQUE(pair, timeframe, ts)
    );
    CREATE INDEX IF NOT EXISTS idx_market_state_pair_tf_ts ON market_state_history(pair, timeframe, ts);

    CREATE TABLE IF NOT EXISTS strategy_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      family_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      strategy_id TEXT,
      symbol TEXT NOT NULL,
      side TEXT,
      target_exposure_pct REAL DEFAULT 0,
      current_exposure_pct REAL DEFAULT 0,
      execution_style TEXT DEFAULT 'ladder',
      expires_at TEXT,
      status TEXT DEFAULT 'active',
      reason TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      closed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_strategy_targets_symbol_status ON strategy_targets(symbol, status, updated_at);

    CREATE TABLE IF NOT EXISTS strategy_ladder_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id INTEGER NOT NULL REFERENCES strategy_targets(id),
      rung_index INTEGER NOT NULL,
      intent TEXT NOT NULL,
      price REAL,
      size REAL NOT NULL,
      reduce_only INTEGER DEFAULT 0,
      status TEXT DEFAULT 'working',
      expires_at TEXT,
      bitget_order_id TEXT,
      trade_id TEXT,
      filled_size REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(target_id, rung_index, intent)
    );
    CREATE INDEX IF NOT EXISTS idx_strategy_ladder_status ON strategy_ladder_orders(status, bitget_order_id, target_id);

    -- Kernel Event Store: append-only event log for OS kernel
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
  try { db.exec('ALTER TABLE compound_strategies ADD COLUMN family_id TEXT'); } catch {}
  try { db.exec('ALTER TABLE compound_strategies ADD COLUMN version_id TEXT'); } catch {}
  try { db.exec('ALTER TABLE compound_strategies ADD COLUMN role TEXT'); } catch {}
  try { db.exec("ALTER TABLE compound_strategies ADD COLUMN target_json TEXT DEFAULT '{}'"); } catch {}
  try { db.exec("ALTER TABLE compound_strategies ADD COLUMN execution_json TEXT DEFAULT '{}'"); } catch {}
  try { db.exec("ALTER TABLE compound_rules ADD COLUMN family_id TEXT"); } catch {}
  try { db.exec("ALTER TABLE compound_rules ADD COLUMN version_id TEXT"); } catch {}
  try { db.exec("ALTER TABLE compound_rules ADD COLUMN scope TEXT DEFAULT 'global'"); } catch {}
  try { db.exec("ALTER TABLE strategy_versions ADD COLUMN decision_mode TEXT DEFAULT 'trigger'"); } catch {}
  // Index on migrated columns (must run after ALTER TABLE)
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_cs_family_version_status ON compound_strategies(family_id, version_id, status)"); } catch {}

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
    try { insert(newsArr); } catch (e) { _log.warn('db_news_insert_error', { module: 'db', error: e.message }); }
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
    } catch (e) { _log.warn('db_analysis_insert_error', { module: 'db', error: e.message }); }
  }

  function persistPatrol(mode, report, period, scans, riskRange, sentRange, trades, now) {
    try {
      insertPatrol.run(mode, report, period, scans, riskRange, sentRange, trades, now);
    } catch (e) { _log.warn('db_patrol_insert_error', { module: 'db', error: e.message }); }
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
    INSERT INTO compound_strategies (strategy_id, name, description, direction, symbols, timeframe, entry_conditions, exit_conditions, sizing_json, risk_params_json, target_json, execution_json, status, confidence, source_compound_run)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(strategy_id) DO UPDATE SET
      name = excluded.name, description = excluded.description, direction = excluded.direction,
      symbols = excluded.symbols, entry_conditions = excluded.entry_conditions,
      exit_conditions = excluded.exit_conditions, sizing_json = excluded.sizing_json,
      risk_params_json = excluded.risk_params_json, target_json = excluded.target_json,
      execution_json = excluded.execution_json, status = excluded.status,
      confidence = excluded.confidence, source_compound_run = excluded.source_compound_run
  `);
  const updateCompoundStrategyStatus = db.prepare(`
    UPDATE compound_strategies SET status = ?, activated_at = CASE WHEN ? = 'active' THEN datetime('now') ELSE activated_at END,
    retired_at = CASE WHEN ? = 'retired' THEN datetime('now') ELSE retired_at END, retired_reason = ? WHERE strategy_id = ?
  `);
  const updateCompoundStrategyEvidence = db.prepare(`
    UPDATE compound_strategies SET evidence_json = ? WHERE strategy_id = ?
  `);

  const insertIntel = db.prepare(`
    INSERT OR IGNORE INTO intel_items (title, source, link, score, signal, coins, category, origin, hash, triggered)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertMarketState = db.prepare(`
    INSERT INTO market_state_history (pair, timeframe, ts, mark_price, index_price, open_interest, funding_rate, basis_bps, oi_change_24h, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pair, timeframe, ts) DO UPDATE SET
      mark_price = excluded.mark_price,
      index_price = excluded.index_price,
      open_interest = excluded.open_interest,
      funding_rate = excluded.funding_rate,
      basis_bps = excluded.basis_bps,
      oi_change_24h = excluded.oi_change_24h,
      source = excluded.source
  `);

  const createStrategyTarget = db.prepare(`
    INSERT INTO strategy_targets
      (family_id, version_id, strategy_id, symbol, side, target_exposure_pct, current_exposure_pct, execution_style, expires_at, status, reason, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `);
  const updateStrategyTarget = db.prepare(`
    UPDATE strategy_targets
    SET strategy_id = ?, side = ?, target_exposure_pct = ?, current_exposure_pct = ?, execution_style = ?, expires_at = ?, status = ?, reason = ?, updated_at = datetime('now')
    WHERE id = ?
  `);
  const closeStrategyTarget = db.prepare(`
    UPDATE strategy_targets
    SET status = ?, current_exposure_pct = ?, updated_at = datetime('now'), closed_at = CASE WHEN ? != 'active' THEN datetime('now') ELSE closed_at END
    WHERE id = ?
  `);
  const createStrategyLadderOrder = db.prepare(`
    INSERT INTO strategy_ladder_orders
      (target_id, rung_index, intent, price, size, reduce_only, status, expires_at, bitget_order_id, trade_id, filled_size, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(target_id, rung_index, intent) DO UPDATE SET
      price = excluded.price,
      size = excluded.size,
      reduce_only = excluded.reduce_only,
      status = excluded.status,
      expires_at = excluded.expires_at,
      bitget_order_id = excluded.bitget_order_id,
      trade_id = excluded.trade_id,
      filled_size = excluded.filled_size,
      updated_at = datetime('now')
  `);
  const updateStrategyLadderOrder = db.prepare(`
    UPDATE strategy_ladder_orders
    SET status = ?, bitget_order_id = ?, trade_id = ?, filled_size = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

  function getActiveStrategyTarget(symbol, familyId = null, versionId = null) {
    let sql = `SELECT * FROM strategy_targets WHERE symbol = ? AND status = 'active'`;
    const args = [symbol];
    if (familyId) { sql += ' AND family_id = ?'; args.push(familyId); }
    if (versionId) { sql += ' AND version_id = ?'; args.push(versionId); }
    sql += ' ORDER BY updated_at DESC LIMIT 1';
    return db.prepare(sql).get(...args) || null;
  }

  function getStrategyTargetById(id) {
    return db.prepare('SELECT * FROM strategy_targets WHERE id = ?').get(id) || null;
  }

  function listStrategyTargets(status = 'active') {
    return db.prepare(
      "SELECT * FROM strategy_targets WHERE status = ? ORDER BY updated_at DESC"
    ).all(status);
  }

  function listStrategyLadderOrders(status = 'working') {
    return db.prepare(
      "SELECT * FROM strategy_ladder_orders WHERE status = ? ORDER BY updated_at DESC, id DESC"
    ).all(status);
  }

  function getLadderOrdersForTarget(targetId, statuses = ['working']) {
    if (!statuses?.length) {
      return db.prepare('SELECT * FROM strategy_ladder_orders WHERE target_id = ? ORDER BY rung_index ASC').all(targetId);
    }
    const placeholders = statuses.map(() => '?').join(', ');
    return db.prepare(
      `SELECT * FROM strategy_ladder_orders WHERE target_id = ? AND status IN (${placeholders}) ORDER BY rung_index ASC`
    ).all(targetId, ...statuses);
  }

  function findStrategyLadderOrderByBitgetOrderId(orderId) {
    return db.prepare('SELECT * FROM strategy_ladder_orders WHERE bitget_order_id = ? ORDER BY id DESC LIMIT 1').get(orderId) || null;
  }

  function getLatestMarketState(pair, timeframe = '1H') {
    return db.prepare(
      'SELECT * FROM market_state_history WHERE pair = ? AND timeframe = ? ORDER BY ts DESC LIMIT 1'
    ).get(pair, timeframe) || null;
  }

  function getMarketStateRange(pair, timeframe, startTs, endTs) {
    let sql = 'SELECT * FROM market_state_history WHERE pair = ? AND timeframe = ?';
    const args = [pair, timeframe];
    if (startTs !== undefined && startTs !== null) { sql += ' AND ts >= ?'; args.push(startTs); }
    if (endTs !== undefined && endTs !== null) { sql += ' AND ts <= ?'; args.push(endTs); }
    sql += ' ORDER BY ts ASC';
    return db.prepare(sql).all(...args);
  }

  const upsertMemoryBackup = db.prepare(`
    INSERT INTO memory_backup (key, content, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET content = excluded.content, updated_at = datetime('now')
  `);

  function backupMemory(key, content) {
    try { upsertMemoryBackup.run(key, content); } catch {}
  }

  function restoreMemory(key) {
    try {
      const row = db.prepare('SELECT content, updated_at FROM memory_backup WHERE key = ?').get(key);
      return row || null;
    } catch { return null; }
  }

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
    insertPush, insertIntel,
    upsertMarketState, createStrategyTarget, updateStrategyTarget, closeStrategyTarget,
    createStrategyLadderOrder, updateStrategyLadderOrder,
    getActiveStrategyTarget, getStrategyTargetById, listStrategyTargets,
    listStrategyLadderOrders, getLadderOrdersForTarget, findStrategyLadderOrderByBitgetOrderId,
    getLatestMarketState, getMarketStateRange,
    backupMemory, restoreMemory,
  };
}
