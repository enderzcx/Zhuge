/**
 * Task Scheduler — executes agent-created scheduled tasks.
 * Checks every 60s for due tasks, runs them, records results.
 *
 * Actions:
 *   scan_hot_altcoins — scanner.scanMarketOpportunities() + TG push top N
 *   full_analysis     — pipeline.collectAndAnalyze()
 *   compound_review   — compound.run()
 *   custom            — LLM-driven execution via agentRunner
 */

export function createTaskScheduler({ db, pipeline, scanner, compound, log, metrics, pushEngine }) {
  const _log = log || { info() {}, warn() {}, error() {} };
  const _m = metrics || { record() {} };
  let _timer = null;
  let _running = false;

  const _db = db.db || db;

  // Prepared statements
  const stmtDue = _db.prepare(`SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at`);
  const stmtUpdateRun = _db.prepare(`UPDATE scheduled_tasks SET last_run_at = ?, next_run_at = ?, run_count = run_count + 1, last_error = NULL WHERE task_id = ?`);
  const stmtUpdateError = _db.prepare(`UPDATE scheduled_tasks SET error_count = error_count + 1, last_error = ? WHERE task_id = ?`);
  const stmtDisable = _db.prepare(`UPDATE scheduled_tasks SET enabled = 0 WHERE task_id = ?`);
  const stmtInsertRun = _db.prepare(`INSERT INTO scheduled_task_runs (task_id, status, duration_ms, result_summary, error_message) VALUES (?, ?, ?, ?, ?)`);

  // --- Built-in action executors ---
  const ACTIONS = {
    async scan_hot_altcoins(params) {
      const opportunities = await scanner.scanMarketOpportunities();
      const topN = params.top_n || 5;
      const top = opportunities.slice(0, topN);
      if (top.length > 0 && pushEngine?.pushError) {
        const lines = top.map((o, i) => `${i + 1}. ${o.symbol} ${(o.change24h * 100).toFixed(1)}% vol:${(o.volume / 1e6).toFixed(1)}M RSI:${o.rsi || '?'}`);
        pushEngine.pushError({ source: 'scheduler', message: `热门山寨 Top ${topN}:\n${lines.join('\n')}` });
      }
      return { count: top.length, top: top.map(o => o.symbol) };
    },

    async full_analysis() {
      const nextMin = await pipeline.collectAndAnalyze();
      return { next_check_min: nextMin || 30 };
    },

    async compound_review() {
      if (!compound?.run) return { error: 'compound not available' };
      const result = await compound.run();
      return result || { skipped: true };
    },
  };

  // --- Calculate next run time ---
  function _calcNextRun(task) {
    const now = new Date();
    if (task.schedule_type === 'interval' && task.interval_ms) {
      return new Date(now.getTime() + task.interval_ms).toISOString();
    }
    if (task.schedule_type === 'daily') {
      const next = new Date(now);
      next.setUTCHours(task.daily_hour || 0, task.daily_minute || 0, 0, 0);
      if (next <= now) next.setUTCDate(next.getUTCDate() + 1); // tomorrow
      return next.toISOString();
    }
    if (task.schedule_type === 'once') {
      return null; // one-shot: disable after execution
    }
    return new Date(now.getTime() + 3600000).toISOString(); // fallback 1h
  }

  // --- Execute a single task ---
  async function _execute(task) {
    const start = Date.now();
    _log.info('scheduler_task_start', { module: 'scheduler', taskId: task.task_id, name: task.name, action: task.action });

    try {
      const actionFn = ACTIONS[task.action];
      if (!actionFn) {
        throw new Error(`Unknown action: ${task.action}`);
      }
      const params = JSON.parse(task.metadata || '{}');
      const result = await actionFn(params);
      const duration = Date.now() - start;

      // Record success
      stmtInsertRun.run(task.task_id, 'success', duration, JSON.stringify(result).slice(0, 500), null);
      _m.record('scheduler_task_ms', duration, { task: task.action });

      // Schedule next run
      const nextRun = _calcNextRun(task);
      if (nextRun) {
        stmtUpdateRun.run(new Date().toISOString(), nextRun, task.task_id);
      } else {
        // One-shot: disable
        stmtDisable.run(task.task_id);
        stmtUpdateRun.run(new Date().toISOString(), null, task.task_id);
      }

      _log.info('scheduler_task_done', { module: 'scheduler', taskId: task.task_id, durationMs: duration });
      return result;
    } catch (err) {
      const duration = Date.now() - start;
      stmtInsertRun.run(task.task_id, 'failed', duration, null, err.message);
      stmtUpdateError.run(err.message, task.task_id);
      _log.error('scheduler_task_error', { module: 'scheduler', taskId: task.task_id, error: err.message });

      // Disable after 5 consecutive errors
      if ((task.error_count || 0) + 1 >= 5) {
        stmtDisable.run(task.task_id);
        _log.warn('scheduler_task_disabled', { module: 'scheduler', taskId: task.task_id, reason: '5 consecutive errors' });
      }
    }
  }

  // --- Check loop ---
  async function _check() {
    if (_running) return;
    _running = true;
    try {
      const now = new Date().toISOString();
      const dueTasks = stmtDue.all(now);
      for (const task of dueTasks) {
        await _execute(task);
      }
    } catch (e) {
      _log.error('scheduler_check_error', { module: 'scheduler', error: e.message });
    } finally {
      _running = false;
    }
  }

  function start() {
    _timer = setInterval(_check, 60_000);
    // Delay first check 30s after startup to let other modules init
    setTimeout(_check, 30_000);
    _log.info('scheduler_started', { module: 'scheduler' });
  }

  function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
  }

  /** Force refresh (called after task creation). */
  function refresh() {
    _check().catch(() => {});
  }

  return { start, stop, refresh };
}
