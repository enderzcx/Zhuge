/**
 * Trade routes: record, close, list, stats.
 * Extracted from vps-api-index.mjs lines ~2493-2577.
 */

export function registerTradeRoutes(app, { db }) {

  const insertTrade = db.insertTrade;
  const updateTradeClose = db.updateTradeClose;

  app.post('/api/trades', (req, res) => {
    const t = req.body;
    if (!t.trade_id || !t.side) return res.status(400).json({ error: 'trade_id and side required' });
    try {
      insertTrade.run(
        t.trade_id, t.source || 'onchain', t.pair || 'WETH/USDC', t.side,
        t.entry_price || 0, t.amount || 0, t.amount_out || 0,
        t.status || 'open', t.tx_hash || '',
        t.signal_snapshot ? JSON.stringify(t.signal_snapshot) : null,
        t.decision_reasoning || '', t.opened_at || new Date().toISOString()
      );
      res.json({ success: true, trade_id: t.trade_id });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/trades/:tradeId/close', (req, res) => {
    const { tradeId } = req.params;
    const { exit_price, pnl, pnl_pct } = req.body;
    try {
      updateTradeClose.run(exit_price || 0, pnl || 0, pnl_pct || 0, new Date().toISOString(), tradeId);
      res.json({ success: true, trade_id: tradeId });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/trades', (req, res) => {
    const status = req.query.status;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    let rows, total;
    if (status) {
      rows = db.db.prepare('SELECT * FROM trades WHERE status = ? ORDER BY opened_at DESC LIMIT ? OFFSET ?').all(status, limit, offset);
      total = db.db.prepare('SELECT COUNT(*) as cnt FROM trades WHERE status = ?').get(status).cnt;
    } else {
      rows = db.db.prepare('SELECT * FROM trades ORDER BY opened_at DESC LIMIT ? OFFSET ?').all(limit, offset);
      total = db.db.prepare('SELECT COUNT(*) as cnt FROM trades').get().cnt;
    }
    res.json({ data: rows, total, limit, offset });
  });

  app.get('/api/trades/stats', (req, res) => {
    const closed = db.db.prepare('SELECT * FROM trades WHERE status = ? ORDER BY closed_at DESC').all('closed');
    const open = db.db.prepare('SELECT * FROM trades WHERE status = ? ORDER BY opened_at DESC').all('open');

    const wins = closed.filter(t => t.pnl > 0);
    const losses = closed.filter(t => t.pnl <= 0);
    const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
    const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;

    // Max drawdown: running max peak - current equity
    let peak = 0, maxDrawdown = 0, equity = 0;
    for (const t of closed.slice().reverse()) {
      equity += t.pnl || 0;
      if (equity > peak) peak = equity;
      const dd = peak - equity;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    // Profit factor
    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    res.json({
      total_trades: closed.length,
      open_trades: open.length,
      wins: wins.length,
      losses: losses.length,
      win_rate: closed.length > 0 ? ((wins.length / closed.length) * 100).toFixed(1) + '%' : 'N/A',
      total_pnl: Number(totalPnl.toFixed(4)),
      avg_win: Number(avgWin.toFixed(4)),
      avg_loss: Number(avgLoss.toFixed(4)),
      profit_factor: Number(profitFactor.toFixed(2)),
      max_drawdown: Number(maxDrawdown.toFixed(4)),
      open_positions: open.map(t => ({ trade_id: t.trade_id, pair: t.pair, side: t.side, amount: t.amount, entry_price: t.entry_price })),
      recent_closed: closed.slice(0, 10).map(t => ({
        trade_id: t.trade_id, pair: t.pair, side: t.side, pnl: t.pnl, pnl_pct: t.pnl_pct,
        entry_price: t.entry_price, exit_price: t.exit_price, opened_at: t.opened_at, closed_at: t.closed_at,
      })),
    });
  });
}
