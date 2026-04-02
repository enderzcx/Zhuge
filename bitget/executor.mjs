/**
 * Bitget trade executor: mutex lock + order placement + trade sync.
 */

export function createBitgetExecutor({ db, config, bitgetClient, messageBus, reviewer }) {
  const { bitgetRequest } = bitgetClient;
  const { postMessage } = messageBus;
  const { insertTrade, insertDecision, updateTradeClose } = db;

  // Trading mutex — prevent analyst + scanner from trading simultaneously
  let _tradingLock = false;

  const tradingLock = {
    acquire() {
      if (_tradingLock) return false;
      _tradingLock = true;
      return true;
    },
    release() {
      _tradingLock = false;
    },
  };

  async function executeBitgetTrade(signal, traceId) {
    if (!config.BITGET_API_KEY) { console.log('[BitgetExec] No API key, skip'); return; }
    if (!tradingLock.acquire()) { console.log('[BitgetExec] Trading lock active, skip'); return; }
    try { await _executeBitgetTradeInner(signal, traceId); } finally { tradingLock.release(); }
  }

  function calculateKellySize(available) {
    // Kelly Criterion: f = (p * b - q) / b
    // p = win rate, q = 1-p, b = avg win / avg loss ratio
    const closedTrades = db.prepare(`
      SELECT pnl FROM trades
      WHERE source = 'bitget' AND status = 'closed' AND entry_price > 0 AND exit_price > 0
      ORDER BY closed_at DESC LIMIT 100
    `).all();

    const minSize = 0.01;

    if (closedTrades.length < 5) return minSize; // not enough history

    const wins = closedTrades.filter(t => t.pnl > 0);
    const losses = closedTrades.filter(t => t.pnl <= 0);

    if (wins.length === 0 || losses.length === 0) return minSize;

    const p = wins.length / closedTrades.length;
    const q = 1 - p;
    const avgWin = wins.reduce((s, t) => s + t.pnl, 0) / wins.length;
    const avgLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length);

    if (avgLoss === 0) return minSize;

    const b = avgWin / avgLoss;
    const kelly = (p * b - q) / b;

    if (kelly <= 0) {
      console.log(`[Kelly] Negative Kelly (${kelly.toFixed(3)}), using min size`);
      return minSize;
    }

    const halfKelly = kelly * 0.5; // half-Kelly for safety
    const fraction = Math.min(halfKelly, 0.25); // cap at 25%

    // Convert USDT margin → notional → ETH contract size (10x leverage)
    const candleRow = db.prepare('SELECT close FROM candles WHERE pair = ? ORDER BY ts_start DESC LIMIT 1').get('ETH-USDT');
    const ethPrice = candleRow?.close || 2000;
    const usdtMargin = fraction * available;
    const ethSize = (usdtMargin * 10) / ethPrice; // leverage=10

    const result = Math.max(minSize, parseFloat(Math.min(ethSize, 1.0).toFixed(2)));
    console.log(`[Kelly] p=${p.toFixed(2)} b=${b.toFixed(2)} f=${kelly.toFixed(3)} half=${fraction.toFixed(3)} → size=${result} ETH (avail=$${available.toFixed(2)})`);
    return result;
  }

  async function _executeBitgetTradeInner(signal, traceId) {

    const action = signal.recommended_action;
    const confidence = signal.confidence || 0;

    // Trade on actionable signals (Risk Agent already approved)
    if (['hold', 'reduce_exposure'].includes(action)) {
      console.log(`[BitgetExec] Action "${action}", skip (manage positions manually)`);
      return;
    }

    // Determine trade params — map actions to sides correctly
    const isBuy = ['strong_buy', 'increase_exposure'].includes(action);
    const side = isBuy ? 'buy' : 'sell';
    const tradeSide = 'open';
    const holdSide = isBuy ? 'long' : 'short';

    // Use ETH futures as default (affordable with small balance)
    const symbol = 'ETHUSDT';
    const leverage = '10';

    try {
      // Check existing positions — don't double up
      try {
        const posData = await bitgetRequest('GET', '/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT');
        const positions = Array.isArray(posData) ? posData : (posData?.list || []);
        const sameDirection = positions.find(p => p.symbol === symbol && p.holdSide === holdSide && parseFloat(p.total || '0') > 0);
        if (sameDirection) {
          console.log(`[BitgetExec] Already have ${holdSide} position on ${symbol}, skip`);
          return;
        }
      } catch {}

      // Check balance first
      const accounts = await bitgetRequest('GET', '/api/v2/mix/account/accounts?productType=USDT-FUTURES');
      const usdtBal = accounts?.find(a => a.marginCoin === 'USDT');
      const available = parseFloat(usdtBal?.crossedMaxAvailable || usdtBal?.available || '0');

      if (available < 0.5) {
        console.log(`[BitgetExec] Insufficient balance: $${available.toFixed(2)}`);
        insertDecision.run(new Date().toISOString(), 'executor', 'skip', '', '',
          JSON.stringify({ reason: 'insufficient_balance', available }), 'Bitget trade skipped', '', '', confidence, null);
        return;
      }

      // Dynamic Kelly position sizing
      const size = String(calculateKellySize(available));

      // Set leverage
      await bitgetRequest('POST', '/api/v2/mix/account/set-leverage', {
        symbol, productType: 'USDT-FUTURES', marginCoin: 'USDT', leverage, holdSide,
      }).catch(() => {});

      // Place order
      const order = await bitgetRequest('POST', '/api/v2/mix/order/place-order', {
        symbol, productType: 'USDT-FUTURES', marginMode: 'crossed', marginCoin: 'USDT',
        side, tradeSide, orderType: 'market', size,
      });

      const orderId = order?.orderId;
      console.log(`[BitgetExec] ${holdSide.toUpperCase()} ${size} ${symbol} ${leverage}x | orderId: ${orderId}`);

      // Record trade (entry_price=0, updated after fill; leverage stored for pnl_pct)
      insertTrade.run(
        `bg_${orderId}`, 'bitget', `${symbol}`, side, 0, parseFloat(size), 0,
        parseInt(leverage, 10), 'open', orderId || '', JSON.stringify(signal),
        `${action} conf:${confidence}`, new Date().toISOString()
      );

      insertDecision.run(new Date().toISOString(), 'executor', 'bitget_trade', 'place-order', JSON.stringify({ symbol, side, size, leverage }),
        JSON.stringify(order), `Bitget ${holdSide} ${symbol}`, '', '', confidence, `bg_${orderId}`);

      postMessage('executor', 'reviewer', 'TRADE_RESULT', { source: 'bitget', orderId, symbol, side, size }, traceId);

      // Fetch actual fill price after market order executes (~3s)
      if (orderId) {
        setTimeout(() => _fetchAndUpdateEntryPrice(orderId, symbol, `bg_${orderId}`), 3000);
      }

    } catch (err) {
      console.error(`[BitgetExec] Failed: ${err.message}`);
      insertDecision.run(new Date().toISOString(), 'executor', 'bitget_error', '', '',
        JSON.stringify({ error: err.message }), 'Bitget trade failed', err.message, '', 0, null);
    }
  }

  async function _fetchAndUpdateEntryPrice(orderId, symbol, tradeId) {
    try {
      const detail = await bitgetRequest('GET', `/api/v2/mix/order/detail?symbol=${symbol}&productType=USDT-FUTURES&orderId=${orderId}`);
      const fillPrice = parseFloat(detail?.priceAvg || detail?.fillPrice || '0');
      if (fillPrice > 0) {
        db.prepare('UPDATE trades SET entry_price = ? WHERE trade_id = ?').run(fillPrice, tradeId);
        console.log(`[TradeSync] Entry price: ${tradeId} @ $${fillPrice}`);
      }
    } catch { /* market order fill, non-critical */ }
  }

  // Detect closed positions and update trades table with exit price + PnL.
  // Called every 5 minutes from index.mjs.
  async function checkAndSyncTrades() {
    if (!config.BITGET_API_KEY) return;
    try {
      const openTrades = db.prepare("SELECT * FROM trades WHERE status = 'open' AND source = 'bitget'").all();
      if (!openTrades.length) return;

      const posData = await bitgetRequest('GET', '/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT');
      const positions = Array.isArray(posData) ? posData : (posData?.list || []);

      for (const trade of openTrades) {
        const holdSide = trade.side === 'buy' ? 'long' : 'short';
        const hasPos = positions.some(p =>
          p.symbol === trade.pair && p.holdSide === holdSide && parseFloat(p.total || '0') > 0
        );
        if (hasPos) continue;

        // Position not found — check if original order is still pending (unfilled limit order)
        if (trade.tx_hash) {
          try {
            const orderDetail = await bitgetRequest('GET', `/api/v2/mix/order/detail?symbol=${trade.pair}&productType=USDT-FUTURES&orderId=${trade.tx_hash}`);
            const orderStatus = orderDetail?.status || orderDetail?.state || '';
            if (['live', 'initial', 'new', 'partial_fill'].includes(orderStatus)) {
              console.log(`[TradeSync] Pending limit order ${trade.trade_id} (${orderStatus}), skip`);
              continue;
            }
          } catch {}
        }

        // Position no longer exists — closed (TP/SL hit or manual)
        const since = new Date(trade.opened_at).getTime();
        const closeSide = trade.side === 'buy' ? 'sell' : 'buy';

        try {
          const history = await bitgetRequest('GET',
            `/api/v2/mix/order/orders-history?symbol=${trade.pair}&productType=USDT-FUTURES&startTime=${since}&endTime=${Date.now()}&limit=50`
          );
          const orders = Array.isArray(history) ? history : (history?.entrustedList || history?.orderList || []);
          const closeOrder = orders.find(o =>
            (o.side === closeSide || o.tradeSide === 'close') &&
            (o.status === 'filled' || o.state === 'filled' || o.status === 'full_fill')
          );

          let exitPrice = parseFloat(closeOrder?.priceAvg || closeOrder?.fillPrice || '0');

          // Fallback: fetch from order detail if not in history list
          if (exitPrice === 0 && closeOrder?.orderId) {
            try {
              const detail = await bitgetRequest('GET', `/api/v2/mix/order/detail?symbol=${trade.pair}&productType=USDT-FUTURES&orderId=${closeOrder.orderId}`);
              exitPrice = parseFloat(detail?.priceAvg || detail?.fillPrice || '0');
            } catch {}
          }

          // Final fallback: use latest candle close as estimate
          if (exitPrice === 0) {
            try {
              const candleRow = db.prepare('SELECT close FROM candles WHERE pair = ? ORDER BY ts_start DESC LIMIT 1').get(trade.pair);
              if (candleRow?.close) exitPrice = parseFloat(candleRow.close);
            } catch {}
          }

          let entryPrice = trade.entry_price || 0;

          // Fallback: if entry_price=0, fetch from Bitget order detail
          if (entryPrice === 0 && trade.tx_hash) {
            try {
              const detail = await bitgetRequest('GET', `/api/v2/mix/order/detail?symbol=${trade.pair}&productType=USDT-FUTURES&orderId=${trade.tx_hash}`);
              entryPrice = parseFloat(detail?.priceAvg || detail?.fillPrice || '0');
              if (entryPrice > 0) {
                db.prepare('UPDATE trades SET entry_price = ? WHERE trade_id = ?').run(entryPrice, trade.trade_id);
              }
            } catch {}
          }

          let pnl = 0, pnlPct = 0;

          if (exitPrice > 0 && entryPrice > 0) {
            const direction = trade.side === 'buy' ? 1 : -1;
            const lev = trade.leverage || 10;
            // Absolute PnL in USDT: direction * price_change * size
            pnl = direction * (exitPrice - entryPrice) * trade.amount;
            // PnL % on margin = (price_change / entry) * direction * leverage * 100
            pnlPct = direction * (exitPrice - entryPrice) / entryPrice * lev * 100;
          }

          updateTradeClose.run(exitPrice, pnl, pnlPct, new Date().toISOString(), trade.trade_id);
          const sign = pnl >= 0 ? '+' : '';
          console.log(`[TradeSync] Closed ${trade.trade_id}: entry=$${entryPrice} exit=$${exitPrice} pnl=${sign}${pnl.toFixed(4)} USDT (${sign}${pnlPct.toFixed(2)}%)`);

          // Trigger reviewer to generate lesson from this closed trade
          if (reviewer) {
            reviewer.runReview(`sync_close_${trade.trade_id}`).catch(err =>
              console.error('[TradeSync] Reviewer trigger failed:', err.message)
            );
          }
        } catch {
          // Can't find fill data — mark closed to avoid re-checking indefinitely
          updateTradeClose.run(0, 0, 0, new Date().toISOString(), trade.trade_id);
          console.log(`[TradeSync] Marked closed (no fill data): ${trade.trade_id}`);
        }
      }
    } catch (e) {
      console.error('[TradeSync] Error:', e.message);
    }
  }

  return { executeBitgetTrade, tradingLock, checkAndSyncTrades };
}
