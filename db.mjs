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
  `);

  const insertNews = db.prepare(`
    INSERT OR IGNORE INTO news (title, summary, source, link, score, signal, link_hash, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAnalysis = db.prepare(`
    INSERT INTO analysis (mode, result_json, macro_risk_score, crypto_sentiment, stock_sentiment, technical_bias, recommended_action, confidence, push_worthy, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTrade = db.prepare(`
    INSERT INTO trades (trade_id, source, pair, side, entry_price, amount, amount_out, status, tx_hash, signal_snapshot, decision_reasoning, opened_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  // Proxy prepare/exec so modules can call db.prepare() directly
  return {
    db,
    prepare: (...args) => db.prepare(...args),
    exec: (...args) => db.exec(...args),
    insertNews, insertAnalysis, insertTrade, updateTradeClose,
    insertDecision, insertPatrol, insertCandle, insertSignalScore,
    persistNews, persistAnalysis, persistPatrol,
  };
}
