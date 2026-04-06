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

// Bounds for AI-generated strategy parameters
const STRATEGY_BOUNDS = {
  margin_usdt: [0.5, 10],
  leverage: [1, 20],
  kelly_fraction_cap: [0.05, 0.3],
  sl_pct: [0.005, 0.1],
  tp_pct: [0.01, 0.15],
  max_hold_minutes: [5, 1440],
};

const VALID_OPERATORS = new Set(['gt', 'lt', 'gte', 'lte', 'eq', 'between', 'in']);
const VALID_DIRECTIONS = new Set(['long', 'short', 'both']);

export function createCompound({ db, llm, provenance, log, metrics, rag }) {
  const _log = log || { info() {}, warn() {}, error() {} };
  const _m = metrics || { record() {} };

  // Ensure tables exist (canonical definition in db.mjs, kept here for standalone usage)
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

    // Check if there's enough data to review (trades OR vetoes OR signal scores)
    let vetoCount = 0;
    try { vetoCount = db.prepare("SELECT COUNT(*) as cnt FROM decisions WHERE agent='risk' AND action='veto' AND timestamp > datetime('now', '-7 days')").get().cnt; } catch {}

    if (trades.length < MIN_TRADES_FOR_COMPOUND && vetoCount < 10) {
      _log.info('compound_skip', { module: 'compound', trades: trades.length, vetoes: vetoCount, reason: 'not enough data' });
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

    // --- Gather system-wide review data (not just trades) ---

    // 1. Risk veto patterns
    let vetoData = [];
    try {
      const vetoes = db.prepare(
        "SELECT timestamp, confidence, output_summary FROM decisions WHERE agent = 'risk' AND action = 'veto' AND timestamp > datetime('now', '-7 days') ORDER BY timestamp DESC LIMIT 20"
      ).all();
      vetoData = vetoes.map(v => ({ ts: v.timestamp, conf: v.confidence, reason: (v.output_summary || '').slice(0, 100) }));
    } catch {}

    // 2. Signal accuracy (analyst prediction vs reality)
    let signalAccuracy = null;
    try {
      signalAccuracy = db.prepare(
        "SELECT COUNT(*) as total, SUM(CASE WHEN correct_1h=1 THEN 1 ELSE 0 END) as ok_1h, SUM(CASE WHEN correct_4h=1 THEN 1 ELSE 0 END) as ok_4h FROM signal_scores WHERE scored_at > datetime('now', '-7 days')"
      ).get();
    } catch {}

    // 3. Momentum funnel (discovered → researched → traded)
    let momentumFunnel = null;
    try {
      momentumFunnel = db.prepare(
        "SELECT COUNT(*) as discovered, SUM(CASE WHEN traded=1 THEN 1 ELSE 0 END) as traded, SUM(CASE WHEN research_verdict='TRADE' THEN 1 ELSE 0 END) as trade_worthy FROM coin_candidates WHERE discovered_at > datetime('now', '-7 days')"
      ).get();
    } catch {}

    // 4. Analyst action distribution
    let analystActions = [];
    try {
      analystActions = db.prepare(
        "SELECT recommended_action, COUNT(*) as cnt, ROUND(AVG(confidence),1) as avg_conf FROM analysis WHERE created_at > datetime('now', '-7 days') GROUP BY recommended_action"
      ).all();
    } catch {}

    // 5. Strategy performance (trades linked to compound strategies)
    let strategyPerf = [];
    try {
      const activeStrats = db.prepare("SELECT strategy_id, name, confidence, evidence_json FROM compound_strategies WHERE status = 'active'").all();
      for (const s of activeStrats) {
        const stratTrades = db.prepare("SELECT pnl, pnl_pct FROM trades WHERE strategy_id = ? AND status = 'closed'").all(s.strategy_id);
        const wins = stratTrades.filter(t => t.pnl > 0).length;
        const totalPnl = stratTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
        const winRate = stratTrades.length > 0 ? wins / stratTrades.length : 0;

        // Update evidence in DB
        const evidence = { win_rate: winRate, sample_size: stratTrades.length, pnl_total: totalPnl, wins, losses: stratTrades.length - wins };
        try { db.prepare('UPDATE compound_strategies SET evidence_json = ? WHERE strategy_id = ?').run(JSON.stringify(evidence), s.strategy_id); } catch {}

        // Auto-retire losing strategies: 5+ trades, win rate < 30%
        if (stratTrades.length >= 5 && winRate < 0.3) {
          try {
            db.prepare("UPDATE compound_strategies SET status = 'retired', retired_at = datetime('now'), retired_reason = ? WHERE strategy_id = ?")
              .run(`auto: ${stratTrades.length} trades, ${(winRate * 100).toFixed(0)}% win rate`, s.strategy_id);
            _log.info('strategy_auto_retired', { module: 'compound', strategy_id: s.strategy_id, trades: stratTrades.length, winRate });
          } catch {}
        }

        strategyPerf.push({ id: s.strategy_id, name: s.name, trades: stratTrades.length, wins, pnl: totalPnl.toFixed(2), winRate: (winRate * 100).toFixed(0) + '%' });
      }
    } catch {}

    // 6. System errors
    let errorCount = 0;
    try {
      const r = db.prepare("SELECT COALESCE(SUM(value),0) as total FROM metrics WHERE name='error_count' AND ts > ?").get(Date.now() - 7 * 86400000);
      errorCount = r.total || 0;
    } catch {}

    // 7. RAG knowledge entries (for feedback loop)
    let knowledgeEntries = [];
    try {
      if (rag?.getAll) knowledgeEntries = await rag.getAll({ limit: 30 });
    } catch {}

    // --- Build comprehensive review prompt ---

    const systemReview = [
      vetoData.length > 0 ? `Risk 否决记录 (${vetoData.length}次/7天):\n${JSON.stringify(vetoData, null, 1)}` : '',
      signalAccuracy ? `信号准确率 (7天): 总${signalAccuracy.total}条, 1h正确${signalAccuracy.ok_1h} (${signalAccuracy.total > 0 ? Math.round(signalAccuracy.ok_1h / signalAccuracy.total * 100) : 0}%), 4h正确${signalAccuracy.ok_4h} (${signalAccuracy.total > 0 ? Math.round(signalAccuracy.ok_4h / signalAccuracy.total * 100) : 0}%)` : '',
      momentumFunnel ? `Momentum漏斗 (7天): 发现${momentumFunnel.discovered}币 → 值得交易${momentumFunnel.trade_worthy} → 实际交易${momentumFunnel.traded}` : '',
      analystActions.length > 0 ? `Analyst 行动分布 (7天):\n${analystActions.map(a => `  ${a.recommended_action}: ${a.cnt}次, 平均confidence ${a.avg_conf}`).join('\n')}` : '',
      errorCount > 0 ? `系统错误: ${errorCount}次 (7天)` : '',
      strategyPerf.length > 0 ? `AI 策略表现:\n${strategyPerf.map(s => `  ${s.name} (${s.id}): ${s.trades}笔, 胜率${s.winRate}, PnL ${s.pnl} USDT`).join('\n')}` : '',
      knowledgeEntries.length > 0 ? `知识库条目 (${knowledgeEntries.length}条):\n${knowledgeEntries.map(e => `  [${e.category}] ${e.title} (confidence: ${e.confidence})`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');

    const prompt = `你是一个交易系统复盘专家。你要复盘的不只是交易结果，还有整个决策流程和系统表现。

## 交易数据 (${trades.length}笔已关闭)
${JSON.stringify(tradeData, null, 1)}

## 系统运行状况
${systemReview}

${existingRules.length > 0 ? `## 当前已有规则\n${JSON.stringify(existingRules, null, 1)}\n` : ''}
请全面分析:
1. 交易复盘: 赢/亏的共同点? 应避免的条件? 表现好的条件?
2. 决策流程: Risk 否决模式是否合理? analyst 信号质量如何? 要调阈值吗?
3. 信号校准: analyst 预测准确率是否在改善? 哪个方向（long/short）更准?
4. Momentum 效率: 发现→交易的转化率是否合理? scanner 要调参吗?
5. 已有规则: 是否需要更新或废弃?
6. 系统建议: 整体有什么需要优化的?

输出 JSON 数组, 每条规则:
{
  "rule_id": "unique_snake_case_id",
  "description": "人类可读的规则描述 (中文)",
  "action": "avoid | prefer | adjust_size | adjust_param",
  "evidence": "支撑这条规则的 trade_ids (逗号分隔)",
  "trade_count": 5,
  "confidence": 0.7,
  "status": "active | superseded",
  "param_changes": { }
}

param_changes 是可选的，用于直接修改执行参数（只有你非常有把握时才用）:
  可调参数: leverage (杠杆), tp_pct (止盈%), sl_pct (止损%), margin_per_trade (保证金USDT),
            min_score (最低评分), max_daily_loss (日亏损上限USDT), max_open (最大同时持仓数)
  示例: { "leverage": 5, "sl_pct": 0.03 } 表示杠杆降到5x、止损改为3%

规则要具体可执行，不要泛泛而谈。基于数据，不要编造。
最多 8 条规则。如果已有规则仍然有效，保持其 rule_id 不变并更新 evidence。
要废弃的旧规则设 status: "superseded"。
除了规则外，你还可以生成完整的交易策略。策略比规则更具体：包含入场条件、出场条件、仓位管理。

输出格式:
{
  "rules": [ ... 规则数组，格式同上 ... ],
  "strategies": [
    {
      "strategy_id": "unique_snake_case",
      "name": "策略中文名",
      "description": "策略逻辑描述和依据",
      "direction": "long | short | both",
      "symbols": ["ETHUSDT"],
      "timeframe": "any | asia_session | us_session",
      "entry_conditions": [
        { "type": "indicator", "field": "rsi_14", "operator": "lt", "value": 30, "description": "RSI超卖" }
      ],
      "exit_conditions": [
        { "type": "indicator", "field": "rsi_14", "operator": "gt", "value": 70, "description": "RSI超买" }
      ],
      "sizing": { "margin_usdt": 3, "leverage": 8 },
      "risk_params": { "sl_pct": 0.03, "tp_pct": 0.06, "max_hold_minutes": 480 },
      "confidence": 0.7,
      "evidence": "支撑依据",
      "status": "proposed | active | superseded"
    }
  ]
}

可用的条件 field: rsi_14, funding_rate, volume_ratio, change_24h, ma_20, ma_50, bb_position, bb_width, hour_utc, trend, support_20, resistance_20, price
可用的 operator: gt, lt, gte, lte, eq, between, in
entry_conditions 用 AND 逻辑（全部满足才入场），exit_conditions 用 OR 逻辑（任一满足就出场）。

策略要基于数据（trade patterns, veto patterns, signal accuracy），不要凭空编造。
每个策略至少 2 个入场条件，至少 1 个出场条件。
最多 3 个新策略。已有策略表现差（胜率<30%且>=5笔）应设 status: "superseded"。

如果你觉得当前数据不足以支撑完整策略，可以只输出 rules 不输出 strategies。

你还要评估知识库条目的有效性。基于交易数据，判断哪些知识对交易有帮助、哪些没用。
输出 knowledge_feedback 数组:
  { "title": "知识条目的完整标题", "action": "boost | demote | neutral", "delta": 10, "reason": "原因" }
  delta 范围 -15 到 +15。boost = 该知识被验证有效(+5~+15)，demote = 无效或误导(-5~-15)，neutral = 不做调整(delta=0)。
  只评价你有数据支撑的条目，没把握的不要评。

仅输出 JSON，不要其他文字。`;

    const start = Date.now();
    let result;
    try {
      result = await llm([
        { role: 'system', content: '你是交易复盘专家。输出 JSON 对象 { "rules": [...], "strategies": [...] }。如果没有策略要生成，strategies 可以为空数组。' },
        { role: 'user', content: prompt },
      ], { max_tokens: 2000, timeout: 90000 });
    } catch (err) {
      _log.error('compound_llm_failed', { module: 'compound', error: err.message });
      _m.record('error_count', 1, { module: 'compound', type: 'llm' });
      return null;
    }

    _m.record('llm_latency_ms', Date.now() - start, { module: 'compound' });

    // Parse output — supports both old (array of rules) and new ({ rules, strategies, knowledge_feedback })
    let rules = [];
    let strategies = [];
    let llmKnowledgeFeedback = [];
    try {
      const content = (result.content || result).replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        rules = parsed; // backward compat: plain array = rules only
      } else if (parsed && typeof parsed === 'object') {
        rules = Array.isArray(parsed.rules) ? parsed.rules : [];
        strategies = Array.isArray(parsed.strategies) ? parsed.strategies : [];
        llmKnowledgeFeedback = Array.isArray(parsed.knowledge_feedback) ? parsed.knowledge_feedback : [];
      } else {
        throw new Error('Unexpected format');
      }
    } catch (err) {
      _log.error('compound_parse_failed', { module: 'compound', error: err.message, raw: (result.content || '').slice(0, 200) });
      return null;
    }

    // Apply rules to DB
    let generated = 0, updated = 0, deprecated = 0;
    const upsertStmt = db.prepare(`
      INSERT INTO compound_rules (rule_id, description, action, evidence_trade_ids, trade_count, confidence, status, param_changes_json, source_compound_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(rule_id) DO UPDATE SET
        description = excluded.description,
        action = excluded.action,
        evidence_trade_ids = excluded.evidence_trade_ids,
        trade_count = excluded.trade_count,
        confidence = excluded.confidence,
        status = excluded.status,
        param_changes_json = excluded.param_changes_json,
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
          JSON.stringify(rule.param_changes || {}),
          compoundId,
        );
        if (rule.status === 'superseded') deprecated++;
        else if (existing) updated++;
        else generated++;
      } catch (err) {
        _log.warn('compound_rule_insert_failed', { module: 'compound', rule_id: rule.rule_id, error: err.message });
      }
    }

    // --- Strategy persistence ---
    let strategiesCreated = 0, strategiesUpdated = 0, strategiesRetired = 0;
    const strategyUpsert = db.prepare(`
      INSERT INTO compound_strategies (strategy_id, name, description, direction, symbols, timeframe, entry_conditions, exit_conditions, sizing_json, risk_params_json, status, confidence, source_compound_run)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(strategy_id) DO UPDATE SET
        name = excluded.name, description = excluded.description, direction = excluded.direction,
        symbols = excluded.symbols, entry_conditions = excluded.entry_conditions,
        exit_conditions = excluded.exit_conditions, sizing_json = excluded.sizing_json,
        risk_params_json = excluded.risk_params_json, status = excluded.status,
        confidence = excluded.confidence, source_compound_run = excluded.source_compound_run
    `);

    for (const s of strategies) {
      if (!s.strategy_id || !s.name || !_validateStrategy(s)) {
        _log.warn('compound_strategy_invalid', { module: 'compound', strategy_id: s.strategy_id, reason: 'validation failed' });
        continue;
      }
      try {
        const existing = db.prepare('SELECT id, status FROM compound_strategies WHERE strategy_id = ?').get(s.strategy_id);
        const sizing = _clampStrategyParams(s.sizing || {}, STRATEGY_BOUNDS);
        const risk = _clampStrategyParams(s.risk_params || {}, STRATEGY_BOUNDS);
        const status = s.status === 'superseded' ? 'retired' : (s.confidence >= 0.7 ? 'active' : 'proposed');

        strategyUpsert.run(
          s.strategy_id, s.name, s.description || '',
          VALID_DIRECTIONS.has(s.direction) ? s.direction : 'long',
          JSON.stringify(s.symbols || []),
          s.timeframe || 'any',
          JSON.stringify(s.entry_conditions || []),
          JSON.stringify(s.exit_conditions || []),
          JSON.stringify(sizing),
          JSON.stringify(risk),
          status, s.confidence || 0.5, compoundId,
        );

        if (s.status === 'superseded' || status === 'retired') strategiesRetired++;
        else if (existing) strategiesUpdated++;
        else strategiesCreated++;
      } catch (err) {
        _log.warn('compound_strategy_insert_failed', { module: 'compound', strategy_id: s.strategy_id, error: err.message });
      }
    }

    // Auto-activate proposed strategies that survived 1+ compound cycles (>2h old)
    try {
      const promoted = db.prepare(
        "UPDATE compound_strategies SET status = 'active', activated_at = datetime('now') WHERE status = 'proposed' AND created_at < datetime('now', '-2 hours')"
      ).run();
      if (promoted.changes > 0) _log.info('strategies_auto_activated', { module: 'compound', count: promoted.changes });
    } catch {}

    // --- Knowledge feedback: update RAG confidence based on LLM evaluation ---
    let knowledgeBoosted = 0, knowledgeDemoted = 0;
    const knowledgeFeedback = [];
    if (rag?.updateConfidence) {
      const feedback = llmKnowledgeFeedback;
      for (const fb of feedback) {
        if (!fb.title || !fb.delta || fb.action === 'neutral') continue;
        const delta = Math.min(15, Math.max(-15, fb.delta || 0));
        try {
          await rag.updateConfidence(fb.title, delta);
          if (delta > 0) knowledgeBoosted++;
          else knowledgeDemoted++;
          knowledgeFeedback.push({ title: fb.title, action: fb.action, delta, reason: fb.reason });
        } catch (err) {
          _log.warn('knowledge_feedback_failed', { module: 'compound', title: fb.title, error: err.message });
        }
      }
      if (knowledgeBoosted + knowledgeDemoted > 0) {
        _log.info('knowledge_feedback_applied', { module: 'compound', boosted: knowledgeBoosted, demoted: knowledgeDemoted });
      }
    }

    // Update run stats
    db.prepare('UPDATE compound_runs SET rules_generated = ?, rules_updated = ?, rules_deprecated = ? WHERE id = ?')
      .run(generated, updated, deprecated, compoundId);

    _log.info('compound_complete', {
      module: 'compound',
      trades: trades.length,
      generated, updated, deprecated,
      strategies_created: strategiesCreated, strategies_updated: strategiesUpdated, strategies_retired: strategiesRetired,
      knowledge_boosted: knowledgeBoosted, knowledge_demoted: knowledgeDemoted,
      duration_ms: Date.now() - start,
    });
    _m.record('compound_run', 1, { trades: trades.length, rules: generated + updated, strategies: strategiesCreated + strategiesUpdated });

    return { trades: trades.length, generated, updated, deprecated, strategiesCreated, strategiesUpdated, strategiesRetired, knowledgeBoosted, knowledgeDemoted, knowledgeFeedback };
  }

  /**
   * Get active rules (for prompt injection via loader.mjs).
   */
  function getActiveRules() {
    try {
      return db.prepare("SELECT * FROM compound_rules WHERE status = 'active' ORDER BY confidence DESC").all();
    } catch { return []; }
  }

  /**
   * Get merged param overrides from all active rules.
   * Higher confidence rules take priority.
   * @returns {{ leverage?: number, tp_pct?: number, sl_pct?: number, ... }}
   */
  // Bounds for AI-set parameters (prevent hallucinated extreme values)
  const PARAM_BOUNDS = {
    leverage: [1, 20],
    tp_pct: [0.01, 0.15],
    sl_pct: [0.005, 0.1],
    margin_per_trade: [0.5, 20],
    min_score: [40, 90],
    max_daily_loss: [2, 50],
    max_open: [1, 10],
  };

  function _clampParams(changes) {
    const clamped = {};
    for (const [k, v] of Object.entries(changes)) {
      if (PARAM_BOUNDS[k] && typeof v === 'number') {
        clamped[k] = Math.min(Math.max(v, PARAM_BOUNDS[k][0]), PARAM_BOUNDS[k][1]);
      }
    }
    return clamped;
  }

  function getParamOverrides() {
    try {
      const rules = db.prepare(
        "SELECT param_changes_json, confidence FROM compound_rules WHERE status = 'active' AND param_changes_json != '{}' ORDER BY confidence ASC"
      ).all();
      const merged = {};
      for (const r of rules) {
        try {
          const changes = JSON.parse(r.param_changes_json || '{}');
          Object.assign(merged, _clampParams(changes));
        } catch {}
      }
      return merged;
    } catch { return {}; }
  }

  /**
   * Validate a strategy object from LLM output.
   */
  function _validateStrategy(s) {
    if (!s.entry_conditions?.length || s.entry_conditions.length < 2) return false;
    if (!s.exit_conditions?.length) return false;
    if (!VALID_DIRECTIONS.has(s.direction || '')) return false;
    for (const c of [...(s.entry_conditions || []), ...(s.exit_conditions || [])]) {
      if (!c.field || !VALID_OPERATORS.has(c.operator)) return false;
      if (c.operator === 'between' && (c.value === undefined || c.value2 === undefined)) return false;
    }
    return true;
  }

  function _clampStrategyParams(params, bounds) {
    const clamped = {};
    for (const [k, v] of Object.entries(params)) {
      if (bounds[k] && typeof v === 'number') {
        clamped[k] = Math.min(Math.max(v, bounds[k][0]), bounds[k][1]);
      } else {
        clamped[k] = v;
      }
    }
    return clamped;
  }

  /**
   * Get active compound strategies.
   */
  function getActiveStrategies() {
    try {
      return db.prepare("SELECT * FROM compound_strategies WHERE status = 'active' ORDER BY confidence DESC").all();
    } catch { return []; }
  }

  function getProposedStrategies() {
    try {
      return db.prepare("SELECT * FROM compound_strategies WHERE status = 'proposed' ORDER BY created_at DESC").all();
    } catch { return []; }
  }

  return { shouldRun, run, getActiveRules, getParamOverrides, getActiveStrategies, getProposedStrategies };
}
