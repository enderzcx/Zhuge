/**
 * Learning loop routes: signal accuracy, lessons.
 * Extracted from vps-api-index.mjs lines ~2631-2656.
 */

export function registerLearningRoutes(app, { db, signals }) {

  app.get('/api/signal-accuracy', (req, res) => {
    const days = Math.min(parseInt(req.query.days) || 7, 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const byAction = db.db.prepare(`
      SELECT recommended_action, COUNT(*) as total,
        SUM(CASE WHEN correct_1h = 1 THEN 1 ELSE 0 END) as correct_1h,
        SUM(CASE WHEN correct_4h = 1 THEN 1 ELSE 0 END) as correct_4h,
        AVG(confidence) as avg_confidence
      FROM signal_scores WHERE scored_at > ? GROUP BY recommended_action
    `).all(since);
    const overall = db.db.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN correct_1h = 1 THEN 1 ELSE 0 END) as correct_1h,
        SUM(CASE WHEN correct_4h = 1 THEN 1 ELSE 0 END) as correct_4h
      FROM signal_scores WHERE scored_at > ?
    `).get(since);
    const sourceWeights = signals ? signals.getSourceWeights() : [{ source_name: 'analyst_combined', accuracy: 0, weight: 1.0 }];
    res.json({ days, overall, by_action: byAction, source_weights: sourceWeights });
  });

  app.get('/api/lessons', (req, res) => {
    const active = req.query.active !== 'false';
    const rows = active
      ? db.db.prepare('SELECT * FROM lessons WHERE active = 1 ORDER BY created_at DESC').all()
      : db.db.prepare('SELECT * FROM lessons ORDER BY created_at DESC LIMIT 50').all();
    res.json({ data: rows, count: rows.length });
  });
}
