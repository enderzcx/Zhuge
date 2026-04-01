/**
 * Market routes: prices, candles.
 * Extracted from vps-api-index.mjs lines ~2359-2380.
 */

export function registerMarketRoutes(app, { db, priceStream }) {

  app.get('/api/prices', (req, res) => {
    const pairs = Object.keys(priceStream.priceCache);
    const prices = {};
    for (const pair of pairs) {
      const c = priceStream.priceCache[pair];
      prices[pair] = {
        price: c.price,
        change5m: Number((c.change5m * 100).toFixed(3)),
        high5m: c.high5m,
        low5m: c.low5m,
        updated: c.ts ? new Date(c.ts).toISOString() : null,
      };
    }
    res.json({ prices, ws_connected: priceStream.wsConnected, pairs });
  });

  app.get('/api/candles', (req, res) => {
    const pair = req.query.pair || 'ETH-USDT';
    const hours = Math.min(parseInt(req.query.hours) || 24, 168); // max 7 days
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const rows = db.db.prepare('SELECT pair, open, high, low, close, ts_start FROM candles WHERE pair = ? AND ts_start > ? ORDER BY ts_start ASC').all(pair, since);
    res.json({ pair, hours, count: rows.length, candles: rows });
  });
}
