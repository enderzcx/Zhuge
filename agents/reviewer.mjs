/**
 * Reviewer agent: trade review, signal accuracy analysis, lesson learning, weekly review.
 */

export function createReviewer({ db, config, agentRunner, messageBus, telegram, log }) {
  const _log = log || { info: console.log, warn: console.warn, error: console.error };
  const { runAgent } = agentRunner;
  const { insertDecision } = db;

  const TG_BOT_TOKEN = config.TG_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
  const TG_CHAT_ID = config.TG_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '';

  const REVIEWER_SYSTEM_PROMPT = `You are the RIFI Reviewer Agent. You analyze signal accuracy, completed trades, and extract actionable lessons.

Your workflow:
1. Call get_signal_accuracy to see prediction accuracy stats (most important!)
2. Call get_recent_trades to see recently closed trades
3. Call get_strategies to check strategy scores
4. Based on accuracy data, call save_lesson to record actionable insights
5. Update strategy scores if needed

Rules for save_lesson:
- Each lesson MUST reference specific accuracy numbers (e.g. "strong_buy 1h accuracy 45%")
- Do NOT save generic advice like "be careful" — only data-backed insights
- Good examples:
  "过去7天 strong_buy 信号的1h准确率仅45%，建议提高 confidence 阈值到70"
  "hold 信号4h准确率82%，当前保守策略有效，维持现有判断逻辑"
  "reduce_exposure 信号在 VIX>25 时4h准确率90%，高VIX环境下减仓信号可信度高"
- Save 1-3 lessons per review, not more

Respond with JSON:
{
  "trades_reviewed": <count>,
  "signal_accuracy_summary": "<Chinese one-line summary of accuracy>",
  "lessons_saved": <count>,
  "strategy_updates": [
    { "strategy_id": <id>, "new_score": <0-100>, "reason": "<Chinese>" }
  ],
  "insight": "<Chinese 2-3 sentence insight about trading patterns>"
}`;

  const REVIEWER_TOOLS = [
    {
      type: 'function',
      function: {
        name: 'get_recent_trades',
        description: 'Get recently closed trades with PnL data',
        parameters: {
          type: 'object',
          properties: { limit: { type: 'number', description: 'Number of trades (default 10)' } },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_decisions_for_trade',
        description: 'Get all agent decisions associated with a specific trade',
        parameters: {
          type: 'object',
          properties: { trade_id: { type: 'string', description: 'Trade ID to look up' } },
          required: ['trade_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_strategies',
        description: 'Get all strategies with their current scores',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_strategy_score',
        description: 'Update a strategy score based on performance review',
        parameters: {
          type: 'object',
          properties: {
            strategy_id: { type: 'number', description: 'Strategy ID' },
            score: { type: 'number', description: 'New score 0-100' },
          },
          required: ['strategy_id', 'score'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_signal_accuracy',
        description: 'Get signal prediction accuracy stats grouped by recommended_action. Shows how often each action type was correct at 15m, 1h, 4h horizons.',
        parameters: {
          type: 'object',
          properties: { days: { type: 'number', description: 'Lookback period in days (default 7)' } },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'save_lesson',
        description: 'Save a trading lesson learned from performance data. Must reference specific accuracy stats. Will be injected into Analyst prompt.',
        parameters: {
          type: 'object',
          properties: {
            lesson: { type: 'string', description: 'The lesson (Chinese, one sentence, with specific numbers)' },
            category: { type: 'string', enum: ['bias_correction', 'signal_weight', 'market_state', 'timing'], description: 'Lesson category' },
            confidence: { type: 'number', description: 'Confidence 0-100' },
            expires_days: { type: 'number', description: 'Auto-expire after N days (default: 14, 0=permanent)' },
          },
          required: ['lesson', 'category'],
        },
      },
    },
  ];

  const REVIEWER_EXECUTORS = {
    get_recent_trades: async (args) => {
      const limit = args.limit || 10;
      const rows = db.prepare('SELECT * FROM trades WHERE status = ? ORDER BY closed_at DESC LIMIT ?').all('closed', limit);
      return JSON.stringify(rows.map(t => ({
        trade_id: t.trade_id, pair: t.pair, side: t.side, pnl: t.pnl, pnl_pct: t.pnl_pct,
        entry_price: t.entry_price, exit_price: t.exit_price, opened_at: t.opened_at, closed_at: t.closed_at,
      })));
    },
    get_decisions_for_trade: async (args) => {
      const rows = db.prepare('SELECT * FROM decisions WHERE trade_id = ? ORDER BY timestamp ASC').all(args.trade_id);
      return JSON.stringify(rows.map(d => ({
        agent: d.agent, action: d.action, tool_name: d.tool_name, reasoning: d.reasoning, timestamp: d.timestamp,
      })));
    },
    get_strategies: async () => {
      const rows = db.prepare('SELECT * FROM strategies ORDER BY created_at DESC').all();
      return JSON.stringify(rows.map(r => ({
        id: r.id, goal: r.goal, template: r.template, status: r.status, score: r.score, progress_pct: r.progress_pct,
      })));
    },
    update_strategy_score: async (args) => {
      try {
        db.prepare('UPDATE strategies SET score = ?, updated_at = ? WHERE id = ?')
          .run(args.score, new Date().toISOString(), args.strategy_id);
        return JSON.stringify({ success: true, strategy_id: args.strategy_id, score: args.score });
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
    },
    get_signal_accuracy: async (args) => {
      const days = args.days || 7;
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const rows = db.prepare(`
        SELECT recommended_action,
          COUNT(*) as total,
          SUM(CASE WHEN correct_1h = 1 THEN 1 ELSE 0 END) as correct_1h,
          SUM(CASE WHEN correct_4h = 1 THEN 1 ELSE 0 END) as correct_4h,
          AVG(confidence) as avg_confidence
        FROM signal_scores WHERE scored_at > ? GROUP BY recommended_action
      `).all(since);
      const overall = db.prepare(`
        SELECT COUNT(*) as total,
          SUM(CASE WHEN correct_1h = 1 THEN 1 ELSE 0 END) as correct_1h,
          SUM(CASE WHEN correct_4h = 1 THEN 1 ELSE 0 END) as correct_4h
        FROM signal_scores WHERE scored_at > ?
      `).get(since);
      return JSON.stringify({
        period_days: days,
        overall: {
          total: overall.total,
          accuracy_1h: overall.total > 0 ? ((overall.correct_1h / overall.total) * 100).toFixed(1) + '%' : 'N/A',
          accuracy_4h: overall.total > 0 ? ((overall.correct_4h / overall.total) * 100).toFixed(1) + '%' : 'N/A',
        },
        by_action: rows.map(r => ({
          action: r.recommended_action,
          total: r.total,
          accuracy_1h: r.total > 0 ? ((r.correct_1h / r.total) * 100).toFixed(1) + '%' : 'N/A',
          accuracy_4h: r.total > 0 ? ((r.correct_4h / r.total) * 100).toFixed(1) + '%' : 'N/A',
          avg_confidence: r.avg_confidence?.toFixed(0) || 'N/A',
        })),
      });
    },
    save_lesson: async (args) => {
      const expiresDays = args.expires_days !== undefined ? args.expires_days : 14;
      const expiresAt = expiresDays > 0 ? new Date(Date.now() + expiresDays * 24 * 60 * 60 * 1000).toISOString() : null;
      // Cap active lessons at 10
      const activeCount = db.prepare('SELECT COUNT(*) as cnt FROM lessons WHERE active = 1').get().cnt;
      if (activeCount >= 10) {
        // Deactivate oldest
        db.prepare('UPDATE lessons SET active = 0 WHERE id = (SELECT id FROM lessons WHERE active = 1 ORDER BY created_at ASC LIMIT 1)').run();
      }
      try {
        const result = db.prepare(`
          INSERT INTO lessons (source, lesson, category, confidence, active, expires_at)
          VALUES ('reviewer', ?, ?, ?, 1, ?)
        `).run(args.lesson, args.category || 'general', args.confidence || 50, expiresAt);
        _log.info('lesson_saved', { module: 'lesson', lesson: args.lesson.slice(0, 60) });
        return JSON.stringify({ success: true, id: result.lastInsertRowid });
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
    },
  };

  async function runReview(traceId) {
    const closedCount = db.prepare('SELECT COUNT(*) as cnt FROM trades WHERE status = ?').get('closed').cnt;
    if (closedCount === 0) return null; // Nothing to review

    try {
      const result = await runAgent('reviewer', REVIEWER_SYSTEM_PROMPT, REVIEWER_TOOLS, REVIEWER_EXECUTORS,
        `Review recent trades and evaluate strategy performance. Provide insights.`,
        { trace_id: traceId || `review_${Date.now()}`, max_tokens: 600, timeout: 30000 }
      );

      let parsed;
      try {
        const jsonStr = result.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        parsed = JSON.parse(jsonStr);
      } catch {
        _log.warn('parse_failed', { module: 'reviewer', raw: result.content.slice(0, 100) });
        return null;
      }

      _log.info('review_result', { module: 'reviewer', trades_reviewed: parsed.trades_reviewed, strategy_updates: parsed.strategy_updates?.length || 0 });

      try {
        insertDecision.run(new Date().toISOString(), 'reviewer', 'review', '', '',
          JSON.stringify(parsed), 'Trade review', parsed.weekly_insight || '', '', 0, null);
      } catch (e) { _log.warn('caught_error', { module: 'reviewer', error: e.message }); }

      return parsed;
    } catch (err) {
      _log.error('reviewer_error', { module: 'reviewer', error: err.message });
      return null;
    }
  }

  // --- Weekly Self-Review ---

  const WEEKLY_REVIEW_PROMPT = `You are the RIFI Reviewer Agent performing a WEEKLY review. This is a comprehensive analysis of the past 7 days.

Your workflow:
1. Call get_signal_accuracy with days=7 to get this week's prediction accuracy
2. Call get_recent_trades with limit=20 to see this week's trades
3. Based on data, save 1-3 high-quality lessons using save_lesson
4. Deactivate any outdated lessons using deactivate_lesson

Focus areas:
- Which action types (strong_buy/hold/etc.) were most accurate?
- Any systematic bias? (e.g. too many false strong_buy signals)
- What market conditions led to correct vs incorrect predictions?
- Save data-backed lessons that will improve next week's analysis

Respond with JSON:
{
  "period": "<date range>",
  "total_pnl": <number>,
  "win_rate": "<percent>",
  "best_trade": { "trade_id": "<id>", "pnl": <number>, "lesson": "<Chinese>" },
  "worst_trade": { "trade_id": "<id>", "pnl": <number>, "lesson": "<Chinese>" },
  "signal_accuracy_1h": "<percent>",
  "signal_accuracy_4h": "<percent>",
  "lessons_saved": <count>,
  "lessons_deactivated": <count>,
  "telegram_summary": "<Chinese 5-sentence weekly summary for Telegram push>"
}`;

  const WEEKLY_TOOLS = [
    ...REVIEWER_TOOLS,
    {
      type: 'function',
      function: {
        name: 'deactivate_lesson',
        description: 'Deactivate an outdated lesson that is no longer accurate',
        parameters: {
          type: 'object',
          properties: { lesson_id: { type: 'number', description: 'Lesson ID to deactivate' } },
          required: ['lesson_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_active_lessons',
        description: 'Get all currently active lessons injected into the Analyst prompt',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
  ];

  const WEEKLY_EXECUTORS = {
    ...REVIEWER_EXECUTORS,
    deactivate_lesson: async (args) => {
      try {
        db.prepare('UPDATE lessons SET active = 0 WHERE id = ?').run(args.lesson_id);
        return JSON.stringify({ success: true, lesson_id: args.lesson_id });
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
    },
    get_active_lessons: async () => {
      const rows = db.prepare('SELECT id, lesson, category, confidence, created_at FROM lessons WHERE active = 1 ORDER BY created_at DESC').all();
      return JSON.stringify(rows);
    },
  };

  const WEEKLY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

  async function runWeeklyReview(traceId) {
    // Check if 7+ days since last weekly review
    const last = db.prepare("SELECT timestamp FROM decisions WHERE agent = 'reviewer' AND action = 'weekly_review' ORDER BY timestamp DESC LIMIT 1").get();
    if (last && (Date.now() - new Date(last.timestamp).getTime()) < WEEKLY_INTERVAL_MS) return null;

    _log.info('weekly_review_start', { module: 'weekly_review' });

    try {
      const result = await runAgent('reviewer', WEEKLY_REVIEW_PROMPT, WEEKLY_TOOLS, WEEKLY_EXECUTORS,
        `Perform a comprehensive weekly review. Today: ${new Date().toISOString()}`,
        { trace_id: traceId || `weekly_${Date.now()}`, max_tokens: 1000, timeout: 60000 }
      );

      let parsed;
      try {
        const jsonStr = result.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        parsed = JSON.parse(jsonStr);
      } catch {
        _log.warn('parse_failed', { module: 'weekly_review', raw: result.content.slice(0, 100) });
        return null;
      }

      _log.info('weekly_review_result', { module: 'weekly_review', total_pnl: parsed.total_pnl, win_rate: parsed.win_rate, lessons_saved: parsed.lessons_saved, lessons_deactivated: parsed.lessons_deactivated });

      // Record
      try {
        insertDecision.run(new Date().toISOString(), 'reviewer', 'weekly_review', '', '',
          JSON.stringify(parsed), 'Weekly self-review', parsed.telegram_summary || '', '', 0, null);
      } catch (e) { _log.warn('caught_error', { module: 'weekly_review', error: e.message }); }

      // Push to Telegram if configured
      if (TG_BOT_TOKEN && TG_CHAT_ID && parsed.telegram_summary) {
        try {
          await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TG_CHAT_ID, text: `📊 RIFI Weekly Report\n\n${parsed.telegram_summary}`, parse_mode: 'HTML' }),
            signal: AbortSignal.timeout(10000),
          });
          _log.info('telegram_push_sent', { module: 'weekly_review' });
        } catch (e) {
          _log.error('telegram_push_failed', { module: 'weekly_review', error: e.message });
        }
      }

      return parsed;
    } catch (err) {
      _log.error('weekly_review_error', { module: 'weekly_review', error: err.message });
      return null;
    }
  }

  return { runReview, runWeeklyReview };
}
