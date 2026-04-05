/**
 * Compound Knowledge — LLM self-review of trading history.
 *
 * Pure AI, no human-written rules. The LLM reads provenance data,
 * discovers patterns, and writes rules that get injected into system prompt.
 *
 * Triggered: every N closed trades, or daily end-of-day.
 * Output: compound_rules table entries.
 */

const COMPOUND_THRESHOLD = 10; // trades since last compound
const MIN_TRADES_FOR_COMPOUND = 5;

export function createCompound({ db, llm, provenance, log, metrics }) {
  const _log = log || { info() {}, warn() {}, error() {} };
  const _m = metrics || { record() {} };

  // Ensure tables exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS compound_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id TEXT UNIQUE,
      description TEXT NOT NULL,
      action TEXT,
      evidence_trade_ids TEXT,
      trade_count INTEGER,
      confidence REAL DEFAULT 0,
      status TEXT DEFAULT 'active',
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

  /**
   * Check if compound should run (enough new closed trades).
   */
  function shouldRun() {
    return provenance.countSinceLastCompound() >= COMPOUND_THRESHOLD;
  }

  /**
   * Run compound: LLM reviews trades, discovers patterns, writes rules.
   */
  async function run() {
    const trades = provenance.getRecentClosed(50);
    if (trades.length < MIN_TRADES_FOR_COMPOUND) {
      _log.info('compound_skip', { module: 'compound', trades: trades.length, reason: 'not enough data' });
      return null;
    }

    // Load existing rules for LLM to review
    let existingRules = [];
    try {
      existingRules = db.prepare("SELECT rule_id, description, action, confidence, trade_count FROM compound_rules WHERE status = 'active'").all();
    } catch {}

    // Build LLM prompt
    const tradeData = trades.map(t => ({
      trade_id: t.trade_id,
      symbol: t.symbol,
      side: t.side,
      leverage: t.leverage,
      momentum_score: t.momentum_score,
      funding_rate: t.funding_rate,
      volume_ratio: t.volume_ratio,
      hour_utc: t.hour_utc,
      reasoning: (t.researcher_reasoning || '').slice(0, 200),
      pnl_pct: t.pnl_pct,
      hold_duration_min: t.hold_duration_min,
    }));

    const prompt = `你是一个交易复盘专家。以下是最近 ${trades.length} 笔交易的完整数据:

${JSON.stringify(tradeData, null, 1)}

${existingRules.length > 0 ? `\n当前已有规则:\n${JSON.stringify(existingRules, null, 1)}\n` : ''}
请分析:
1. 赢的交易有什么共同点? 亏的呢?
2. 有没有应该避免的条件组合?
3. 有没有表现特别好的条件?
4. 已有规则是否需要更新或废弃?

输出 JSON 数组, 每条规则:
{
  "rule_id": "unique_snake_case_id",
  "description": "人类可读的规则描述 (中文)",
  "action": "avoid | prefer | adjust_size",
  "evidence": "支撑这条规则的 trade_ids (逗号分隔)",
  "trade_count": 5,
  "confidence": 0.7,
  "status": "active | superseded"
}

规则要具体可执行，不要泛泛而谈。基于数据，不要编造。
最多 5 条规则。如果已有规则仍然有效，保持其 rule_id 不变并更新 evidence。
要废弃的旧规则设 status: "superseded"。
仅输出 JSON 数组，不要其他文字。`;

    const start = Date.now();
    let result;
    try {
      result = await llm([
        { role: 'system', content: '你是交易复盘专家。只输出 JSON 数组。' },
        { role: 'user', content: prompt },
      ], { max_tokens: 1000, timeout: 60000 });
    } catch (err) {
      _log.error('compound_llm_failed', { module: 'compound', error: err.message });
      _m.record('error_count', 1, { module: 'compound', type: 'llm' });
      return null;
    }

    _m.record('llm_latency_ms', Date.now() - start, { module: 'compound' });

    // Parse rules
    let rules;
    try {
      const content = (result.content || result).replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      rules = JSON.parse(content);
      if (!Array.isArray(rules)) throw new Error('Not an array');
    } catch (err) {
      _log.error('compound_parse_failed', { module: 'compound', error: err.message, raw: (result.content || '').slice(0, 200) });
      return null;
    }

    // Apply rules to DB
    let generated = 0, updated = 0, deprecated = 0;
    const upsertStmt = db.prepare(`
      INSERT INTO compound_rules (rule_id, description, action, evidence_trade_ids, trade_count, confidence, status, source_compound_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(rule_id) DO UPDATE SET
        description = excluded.description,
        action = excluded.action,
        evidence_trade_ids = excluded.evidence_trade_ids,
        trade_count = excluded.trade_count,
        confidence = excluded.confidence,
        status = excluded.status,
        source_compound_id = excluded.source_compound_id
    `);

    // Record compound run first to get ID
    const runResult = db.prepare(
      'INSERT INTO compound_runs (trades_reviewed, rules_generated, rules_updated, rules_deprecated, llm_reasoning) VALUES (?, 0, 0, 0, ?)'
    ).run(trades.length, (result.content || '').slice(0, 5000));
    const compoundId = runResult.lastInsertRowid;

    for (const rule of rules) {
      if (!rule.rule_id || !rule.description) continue;
      try {
        const existing = db.prepare('SELECT id FROM compound_rules WHERE rule_id = ?').get(rule.rule_id);
        upsertStmt.run(
          rule.rule_id,
          rule.description,
          rule.action || 'avoid',
          rule.evidence || '',
          rule.trade_count || 0,
          rule.confidence || 0.5,
          rule.status || 'active',
          compoundId,
        );
        if (rule.status === 'superseded') deprecated++;
        else if (existing) updated++;
        else generated++;
      } catch (err) {
        _log.warn('compound_rule_insert_failed', { module: 'compound', rule_id: rule.rule_id, error: err.message });
      }
    }

    // Update run stats
    db.prepare('UPDATE compound_runs SET rules_generated = ?, rules_updated = ?, rules_deprecated = ? WHERE id = ?')
      .run(generated, updated, deprecated, compoundId);

    _log.info('compound_complete', {
      module: 'compound',
      trades: trades.length,
      generated, updated, deprecated,
      duration_ms: Date.now() - start,
    });
    _m.record('compound_run', 1, { trades: trades.length, rules: generated + updated });

    return { trades: trades.length, generated, updated, deprecated };
  }

  /**
   * Get active rules (for prompt injection via loader.mjs).
   */
  function getActiveRules() {
    try {
      return db.prepare("SELECT * FROM compound_rules WHERE status = 'active' ORDER BY confidence DESC").all();
    } catch { return []; }
  }

  return { shouldRun, run, getActiveRules };
}
