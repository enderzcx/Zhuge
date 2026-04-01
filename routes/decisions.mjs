/**
 * Decision routes: record single, batch, query.
 * Extracted from vps-api-index.mjs lines ~2579-2627.
 */

export function registerDecisionRoutes(app, { db }) {

  const insertDecision = db.insertDecision;

  app.post('/api/decisions', (req, res) => {
    const d = req.body;
    if (!d.action) return res.status(400).json({ error: 'action required' });
    try {
      insertDecision.run(
        d.timestamp || new Date().toISOString(), d.agent || 'sentinel', d.action,
        d.tool_name || '', d.tool_args ? JSON.stringify(d.tool_args) : '',
        d.tool_result ? JSON.stringify(d.tool_result) : '',
        d.input_summary || '', d.output_summary || '',
        d.reasoning || '', d.confidence || 0, d.trade_id || null
      );
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/decisions/batch', (req, res) => {
    const items = req.body.decisions;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'decisions array required' });
    const batchInsert = db.db.transaction((list) => {
      for (const d of list) {
        insertDecision.run(
          d.timestamp || new Date().toISOString(), d.agent || 'sentinel', d.action || 'tool_call',
          d.tool_name || '', d.tool_args ? JSON.stringify(d.tool_args) : '',
          d.tool_result ? JSON.stringify(d.tool_result) : '',
          d.input_summary || '', d.output_summary || '',
          d.reasoning || '', d.confidence || 0, d.trade_id || null
        );
      }
    });
    try { batchInsert(items); res.json({ success: true, count: items.length }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/decisions', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const tradeId = req.query.trade_id;
    let rows, total;
    if (tradeId) {
      rows = db.db.prepare('SELECT * FROM decisions WHERE trade_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?').all(tradeId, limit, offset);
      total = db.db.prepare('SELECT COUNT(*) as cnt FROM decisions WHERE trade_id = ?').get(tradeId).cnt;
    } else {
      rows = db.db.prepare('SELECT * FROM decisions ORDER BY timestamp DESC LIMIT ? OFFSET ?').all(limit, offset);
      total = db.db.prepare('SELECT COUNT(*) as cnt FROM decisions').get().cnt;
    }
    res.json({ data: rows, total, limit, offset });
  });
}
