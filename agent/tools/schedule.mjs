/**
 * Schedule tools — let the agent create, list, and manage recurring tasks.
 *
 * Tools:
 *   schedule_task        — create a new scheduled task
 *   list_scheduled_tasks — view all tasks with status
 *   toggle_scheduled_task — enable / disable / delete
 */

import { randomBytes } from 'crypto';

export function createScheduleTools({ db, log, scheduler }) {
  const _log = log || { info() {}, warn() {}, error() {} };
  const _db = db.db || db;

  const stmtInsert = _db.prepare(`
    INSERT INTO scheduled_tasks (task_id, name, description, schedule_type, interval_ms, daily_hour, daily_minute, action, metadata, next_run_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const stmtList = _db.prepare(`SELECT * FROM scheduled_tasks ORDER BY enabled DESC, created_at DESC`);
  const stmtGet = _db.prepare(`SELECT * FROM scheduled_tasks WHERE task_id = ?`);
  const stmtEnable = _db.prepare(`UPDATE scheduled_tasks SET enabled = 1, error_count = 0, last_error = NULL WHERE task_id = ?`);
  const stmtDisable = _db.prepare(`UPDATE scheduled_tasks SET enabled = 0 WHERE task_id = ?`);
  const stmtDelete = _db.prepare(`DELETE FROM scheduled_tasks WHERE task_id = ?`);
  const stmtRecentRuns = _db.prepare(`SELECT status, duration_ms, result_summary, run_at FROM scheduled_task_runs WHERE task_id = ? ORDER BY run_at DESC LIMIT 3`);

  function _calcFirstRun(scheduleType, intervalHours, dailyHour, dailyMinute) {
    const now = new Date();
    if (scheduleType === 'interval' && intervalHours) {
      return new Date(now.getTime() + intervalHours * 3600000).toISOString();
    }
    if (scheduleType === 'daily') {
      const next = new Date(now);
      next.setUTCHours(dailyHour || 0, dailyMinute || 0, 0, 0);
      if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
      return next.toISOString();
    }
    if (scheduleType === 'once') {
      // Execute in 1 minute
      return new Date(now.getTime() + 60000).toISOString();
    }
    return new Date(now.getTime() + 3600000).toISOString();
  }

  const TOOL_DEFS = [
    {
      name: 'schedule_task',
      description: '创建定时任务。可设置间隔(每N小时)或每日固定时间(UTC)或执行一次。用于自动化扫描、分析、复盘等重复工作。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '任务名称 (如 "山寨热门扫描")' },
          description: { type: 'string', description: '任务描述: 执行时做什么' },
          schedule_type: { type: 'string', enum: ['interval', 'daily', 'once'], description: 'interval=每隔N小时, daily=每天固定时间(UTC), once=执行一次' },
          interval_hours: { type: 'number', description: 'interval类型: 间隔小时数 (如 2=每2小时)' },
          daily_hour: { type: 'number', description: 'daily类型: UTC小时 (0-23, 如 0=UTC 0:00=北京8:00)' },
          daily_minute: { type: 'number', description: 'daily类型: 分钟 (默认0)' },
          action: { type: 'string', enum: ['scan_hot_altcoins', 'full_analysis', 'compound_review'], description: '要执行的动作' },
          action_params: { type: 'string', description: 'JSON参数 (如 {"top_n": 5})' },
        },
        required: ['name', 'schedule_type', 'action'],
      },
      requiresConfirmation: false,
    },
    {
      name: 'list_scheduled_tasks',
      description: '查看所有定时任务: 名称、调度、状态、上次/下次运行时间、最近3次执行记录',
      parameters: { type: 'object', properties: {} },
      requiresConfirmation: false,
    },
    {
      name: 'toggle_scheduled_task',
      description: '启用/禁用/删除定时任务',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '任务 ID' },
          action: { type: 'string', enum: ['enable', 'disable', 'delete'], description: '操作' },
        },
        required: ['task_id', 'action'],
      },
      requiresConfirmation: false,
    },
  ];

  const EXECUTORS = {
    async schedule_task({ name, description, schedule_type, interval_hours, daily_hour, daily_minute, action, action_params }) {
      // Validate interval bounds (prevent Date overflow)
      if (schedule_type === 'interval' && (!interval_hours || interval_hours < 0.1 || interval_hours > 720)) {
        return { error: 'interval_hours must be 0.1-720 (6min to 30 days)' };
      }
      if (schedule_type === 'daily' && (daily_hour < 0 || daily_hour > 23)) {
        return { error: 'daily_hour must be 0-23 (UTC)' };
      }
      const taskId = 'task_' + randomBytes(4).toString('hex');
      const intervalMs = schedule_type === 'interval' && interval_hours ? Math.round(interval_hours * 3600000) : null;
      const nextRun = _calcFirstRun(schedule_type, interval_hours, daily_hour, daily_minute);

      try {
        stmtInsert.run(taskId, name, description || '', schedule_type, intervalMs, daily_hour || null, daily_minute || 0, action, action_params || '{}', nextRun);
        _log.info('task_created', { module: 'schedule', taskId, name, action, schedule_type });

        let scheduleDesc = '';
        if (schedule_type === 'interval') scheduleDesc = `每 ${interval_hours} 小时`;
        if (schedule_type === 'daily') scheduleDesc = `每天 UTC ${daily_hour || 0}:${String(daily_minute || 0).padStart(2, '0')} (北京 ${((daily_hour || 0) + 8) % 24}:${String(daily_minute || 0).padStart(2, '0')})`;
        if (schedule_type === 'once') scheduleDesc = '执行一次 (1分钟后)';

        return { ok: true, task_id: taskId, name, action, schedule: scheduleDesc, next_run: nextRun };
      } catch (err) {
        return { error: err.message };
      }
    },

    async list_scheduled_tasks() {
      try {
        const tasks = stmtList.all();
        if (tasks.length === 0) return { tasks: [], message: '暂无定时任务' };

        return {
          tasks: tasks.map(t => {
            const runs = stmtRecentRuns.all(t.task_id);
            let scheduleDesc = t.schedule_type;
            if (t.schedule_type === 'interval') scheduleDesc = `每 ${(t.interval_ms / 3600000).toFixed(1)}h`;
            if (t.schedule_type === 'daily') scheduleDesc = `每天 UTC ${t.daily_hour || 0}:${String(t.daily_minute || 0).padStart(2, '0')}`;
            return {
              task_id: t.task_id,
              name: t.name,
              action: t.action,
              schedule: scheduleDesc,
              enabled: !!t.enabled,
              run_count: t.run_count,
              error_count: t.error_count,
              last_run: t.last_run_at,
              next_run: t.next_run_at,
              last_error: t.last_error,
              recent_runs: runs.map(r => ({ status: r.status, duration_ms: r.duration_ms, at: r.run_at })),
            };
          }),
        };
      } catch (err) {
        return { error: err.message };
      }
    },

    async toggle_scheduled_task({ task_id, action }) {
      const task = stmtGet.get(task_id);
      if (!task) return { error: `任务 ${task_id} 不存在` };

      try {
        if (action === 'enable') {
          stmtEnable.run(task_id);
          // Recalculate next run
          const nextRun = _calcFirstRun(task.schedule_type, task.interval_ms ? task.interval_ms / 3600000 : null, task.daily_hour, task.daily_minute);
          _db.prepare('UPDATE scheduled_tasks SET next_run_at = ? WHERE task_id = ?').run(nextRun, task_id);
          _log.info('task_enabled', { module: 'schedule', taskId: task_id });
          return { ok: true, task_id, action: 'enabled', next_run: nextRun };
        }
        if (action === 'disable') {
          stmtDisable.run(task_id);
          _log.info('task_disabled', { module: 'schedule', taskId: task_id });
          return { ok: true, task_id, action: 'disabled' };
        }
        if (action === 'delete') {
          stmtDelete.run(task_id);
          _db.prepare('DELETE FROM scheduled_task_runs WHERE task_id = ?').run(task_id);
          _log.info('task_deleted', { module: 'schedule', taskId: task_id });
          return { ok: true, task_id, action: 'deleted' };
        }
        return { error: `未知操作: ${action}` };
      } catch (err) {
        return { error: err.message };
      }
    },
  };

  return { TOOL_DEFS, EXECUTORS };
}
