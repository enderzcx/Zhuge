/**
 * Bitget CEX routes: balance, ticker, spot/futures orders, positions.
 * Extracted from vps-api-index.mjs lines ~2924-2999.
 */

export function registerBitgetRoutes(app, { bitgetClient }) {

  const { bitgetRequest, bitgetPublic } = bitgetClient;

  app.get('/api/bitget/balance', async (req, res) => {
    try {
      const [spot, futures] = await Promise.all([
        bitgetRequest('GET', '/api/v2/spot/account/assets'),
        bitgetRequest('GET', '/api/v2/mix/account/accounts?productType=USDT-FUTURES').catch(() => []),
      ]);
      const spotBalances = (spot || []).filter(a => parseFloat(a.available) > 0);
      const futuresBalances = (futures || []).map(a => ({
        coin: a.marginCoin, equity: a.accountEquity, available: a.crossedMaxAvailable || a.available,
        unrealizedPL: a.unrealizedPL || '0',
      }));
      res.json({ spot: spotBalances, futures: futuresBalances });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/bitget/ticker', async (req, res) => {
    const symbol = req.query.symbol || 'BTCUSDT';
    try {
      const data = await bitgetPublic(`/api/v2/spot/market/tickers?symbol=${symbol}`);
      const t = data?.[0];
      if (!t) return res.json({ error: 'No ticker data' });
      res.json({ symbol: t.symbol, price: t.lastPr, change24h: t.change24h, high24h: t.high24h, low24h: t.low24h, volume24h: t.baseVolume });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/bitget/spot-order', async (req, res) => {
    const { symbol, side, amount, price, orderType } = req.body;
    if (!symbol || !side || !amount) return res.status(400).json({ error: 'symbol, side, amount required' });
    try {
      const order = await bitgetRequest('POST', '/api/v2/spot/trade/place-order', {
        symbol, side, orderType: orderType || 'market', force: 'gtc',
        ...(orderType === 'limit' ? { price: String(price), size: String(amount) } : { size: String(amount) }),
      });
      console.log(`[Bitget] Spot ${side} ${amount} ${symbol}: orderId=${order?.orderId}`);
      res.json({ success: true, orderId: order?.orderId, symbol, side, amount });
    } catch (e) {
      console.error(`[Bitget] Spot order failed:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/bitget/futures-order', async (req, res) => {
    const { symbol, side, amount, price, orderType, leverage, marginMode } = req.body;
    if (!symbol || !side || !amount) return res.status(400).json({ error: 'symbol, side, amount required' });
    try {
      // Set leverage if specified
      if (leverage) {
        await bitgetRequest('POST', '/api/v2/mix/account/set-leverage', {
          symbol, productType: 'USDT-FUTURES', marginCoin: 'USDT',
          leverage: String(leverage), holdSide: side === 'buy' ? 'long' : 'short',
        }).catch(() => {});
      }
      const order = await bitgetRequest('POST', '/api/v2/mix/order/place-order', {
        symbol, productType: 'USDT-FUTURES', marginMode: marginMode || 'crossed', marginCoin: 'USDT',
        side: side === 'buy' ? 'buy' : 'sell',
        tradeSide: side === 'buy' ? 'open' : 'close',
        orderType: orderType || 'market', size: String(amount),
        ...(orderType === 'limit' ? { price: String(price) } : {}),
      });
      console.log(`[Bitget] Futures ${side} ${amount} ${symbol}: orderId=${order?.orderId}`);
      res.json({ success: true, orderId: order?.orderId, symbol, side, amount });
    } catch (e) {
      console.error(`[Bitget] Futures order failed:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/bitget/positions', async (req, res) => {
    try {
      const positions = await bitgetRequest('GET', '/api/v2/mix/position/all-position?productType=USDT-FUTURES');
      res.json({ positions: (positions || []).map(p => ({
        symbol: p.symbol, side: p.holdSide, size: p.total, avgPrice: p.averageOpenPrice,
        unrealizedPL: p.unrealizedPL, leverage: p.leverage, liquidationPrice: p.liquidationPrice,
      }))});
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
