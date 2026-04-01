/**
 * Strategy routes: list, create, update.
 * Extracted from vps-api-index.mjs lines ~3050-3098.
 */

export function registerStrategyRoutes(app, { db }) {

  app.get('/api/strategies', (req, res) => {
    const status = req.query.status || 'active';
    const rows = db.db.prepare('SELECT * FROM strategies WHERE status = ? ORDER BY created_at DESC').all(status);
    const data = rows.map(r => ({
      ...r,
      plan_json: r.plan_json ? JSON.parse(r.plan_json) : null,
      params_json: r.params_json ? JSON.parse(r.params_json) : null,
    }));
    res.json({ data, count: data.length });
  });

  app.post('/api/strategies', (req, res) => {
    const { goal, template, plan_json, params_json } = req.body;
    if (!goal) return res.status(400).json({ error: 'goal required' });
    try {
      const now = new Date().toISOString();
      const result = db.db.prepare(`
        INSERT INTO strategies (goal, template, plan_json, params_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?)
      `).run(goal, template || 'custom', plan_json ? JSON.stringify(plan_json) : null,
        params_json ? JSON.stringify(params_json) : null, now, now);
      res.json({ success: true, id: result.lastInsertRowid });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/strategies/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const { status, progress_pct, score, goal, plan_json, params_json } = req.body;
    const now = new Date().toISOString();
    const fields = [];
    const values = [];
    if (status !== undefined) { fields.push('status = ?'); values.push(status); }
    if (progress_pct !== undefined) { fields.push('progress_pct = ?'); values.push(progress_pct); }
    if (score !== undefined) { fields.push('score = ?'); values.push(score); }
    if (goal !== undefined) { fields.push('goal = ?'); values.push(goal); }
    if (plan_json !== undefined) { fields.push('plan_json = ?'); values.push(JSON.stringify(plan_json)); }
    if (params_json !== undefined) { fields.push('params_json = ?'); values.push(JSON.stringify(params_json)); }
    if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });
    fields.push('updated_at = ?'); values.push(now);
    values.push(id);
    try {
      db.db.prepare(`UPDATE strategies SET ${fields.join(', ')} WHERE id = ?`).run(...values);
      res.json({ success: true, id });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
