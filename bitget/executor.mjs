/**
 * Bitget trade executor: mutex lock + order placement.
 */

export function createBitgetExecutor({ db, config, bitgetClient, messageBus }) {
  const { bitgetRequest } = bitgetClient;
  const { postMessage } = messageBus;
  const { insertTrade, insertDecision } = db;

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
    const size = '0.01'; // min ETH size
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
      console.log(`[BitgetExec] ${holdSide.toUpperCase()} ${size} ${symbol} 10x | orderId: ${orderId}`);

      // Record trade
      insertTrade.run(
        `bg_${orderId}`, 'bitget', `${symbol}`, side, 0, parseFloat(size), 0,
        'open', orderId || '', JSON.stringify(signal), `${action} conf:${confidence}`, new Date().toISOString()
      );

      insertDecision.run(new Date().toISOString(), 'executor', 'bitget_trade', 'place-order', JSON.stringify({ symbol, side, size, leverage }),
        JSON.stringify(order), `Bitget ${holdSide} ${symbol}`, '', '', confidence, `bg_${orderId}`);

      postMessage('executor', 'reviewer', 'TRADE_RESULT', { source: 'bitget', orderId, symbol, side, size }, traceId);

    } catch (err) {
      console.error(`[BitgetExec] Failed: ${err.message}`);
      insertDecision.run(new Date().toISOString(), 'executor', 'bitget_error', '', '',
        JSON.stringify({ error: err.message }), 'Bitget trade failed', err.message, '', 0, null);
    }
  }

  return { executeBitgetTrade, tradingLock };
}
