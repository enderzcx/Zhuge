/**
 * History routes: news, analysis, patrol.
 * Extracted from vps-api-index.mjs lines ~2457-2489.
 */

export function registerHistoryRoutes(app, { db }) {

  app.get('/api/history/news', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const rows = db.db.prepare('SELECT * FROM news ORDER BY fetched_at DESC LIMIT ? OFFSET ?').all(limit, offset);
    const total = db.db.prepare('SELECT COUNT(*) as cnt FROM news').get().cnt;
    res.json({ data: rows, total, limit, offset });
  });

  app.get('/api/history/analysis', (req, res) => {
    const mode = req.query.mode === 'stock' ? 'stock' : 'crypto';
    const limit = Math.min(parseInt(req.query.limit) || 24, 200);
    const offset = parseInt(req.query.offset) || 0;
    const rows = db.db.prepare('SELECT * FROM analysis WHERE mode = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(mode, limit, offset);
    const total = db.db.prepare('SELECT COUNT(*) as cnt FROM analysis WHERE mode = ?').get(mode).cnt;
    // Parse result_json back to object
    const data = rows.map(r => ({ ...r, result_json: JSON.parse(r.result_json || '{}') }));
    res.json({ data, total, limit, offset, mode });
  });

  app.get('/api/history/patrol', (req, res) => {
    const mode = req.query.mode;
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const offset = parseInt(req.query.offset) || 0;
    let rows, total;
    if (mode) {
      rows = db.db.prepare('SELECT * FROM patrol_reports WHERE mode = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(mode, limit, offset);
      total = db.db.prepare('SELECT COUNT(*) as cnt FROM patrol_reports WHERE mode = ?').get(mode).cnt;
    } else {
      rows = db.db.prepare('SELECT * FROM patrol_reports ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
      total = db.db.prepare('SELECT COUNT(*) as cnt FROM patrol_reports').get().cnt;
    }
    res.json({ data: rows, total, limit, offset });
  });
}
