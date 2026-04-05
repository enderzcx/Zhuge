/**
 * Bitget trade executor: mutex lock + order placement + trade sync.
 */

export function createBitgetExecutor({ db, config, bitgetClient, messageBus, reviewer, log, metrics }) {
  const _log = log || { info: console.log, warn: console.warn, error: console.error };
  const { bitgetRequest, roundPrice } = bitgetClient;
  const { postMessage } = messageBus;
  const { insertTrade, insertDecision, updateTradeClose,
          insertPositionGroup, insertPositionLevel, updatePositionGroup, closePositionGroup,
          getActiveGroup, getGroupLevels, getLastAbandonedTime } = db;
  const SCALING = config.SCALING;

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
    if (!config.BITGET_API_KEY) { _log.info('no_api_key', { module: 'bitget_exec' }); return; }
    if (!tradingLock.acquire()) { _log.info('trading_lock_active', { module: 'bitget_exec' }); return; }
    try { await _executeBitgetTradeInner(signal, traceId); } finally { tradingLock.release(); }
  }

  function calculateKellySize(available, symbol, currentPrice) {
    // Kelly Criterion: f = (p * b - q) / b
    // p = win rate, q = 1-p, b = avg win / avg loss ratio
    // Filter by symbol if enough data, fallback to all trades
    let closedTrades = db.prepare(`
      SELECT pnl FROM trades
      WHERE source = 'bitget' AND status = 'closed' AND entry_price > 0 AND exit_price > 0 AND pair = ?
      ORDER BY closed_at DESC LIMIT 100
    `).all(symbol);

    // Fallback: if < 5 trades for this symbol, use all trades
    if (closedTrades.length < 5) {
      closedTrades = db.prepare(`
        SELECT pnl FROM trades
        WHERE source = 'bitget' AND status = 'closed' AND entry_price > 0 AND exit_price > 0
        ORDER BY closed_at DESC LIMIT 100
      `).all();
    }

    const minSize = 0.01;

    if (closedTrades.length < 5) return minSize;

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
      _log.info('kelly_negative', { module: 'kelly', kelly: kelly.toFixed(3) });
      return minSize;
    }

    const halfKelly = kelly * 0.5; // half-Kelly for safety
    const fraction = Math.min(halfKelly, 0.25); // cap at 25%

    // Convert USDT margin → notional → contract size (use dynamic leverage)
    if (!currentPrice || currentPrice <= 0) {
      _log.warn('no_valid_price', { module: 'kelly', symbol });
      return 0; // caller must check for 0 and abort
    }
    const effectiveLeverage = config.SCALING?.leverage || config.MOMENTUM?.leverage || 10;
    const usdtMargin = fraction * available;
    const contractSize = (usdtMargin * effectiveLeverage) / currentPrice;

    const result = Math.max(minSize, parseFloat(contractSize.toFixed(4)));
    _log.info('kelly_calc', { module: 'kelly', symbol, p: p.toFixed(2), b: b.toFixed(2), f: kelly.toFixed(3), half: fraction.toFixed(3), size: result, available: available.toFixed(2), price: currentPrice });
    return result;
  }

  async function _executeBitgetTradeInner(signal, traceId) {

    const action = signal.recommended_action;
    const confidence = signal.confidence || 0;

    // Trade on actionable signals (Risk Agent already approved)
    if (['hold', 'reduce_exposure'].includes(action)) {
      _log.info('action_skip', { module: 'bitget_exec', action });
      return;
    }

    // Determine trade params
    const isBuy = ['strong_buy', 'increase_exposure'].includes(action);
    const side = isBuy ? 'buy' : 'sell';
    const tradeSide = 'open';
    const holdSide = isBuy ? 'long' : 'short';

    // Symbol from analyst signal — whitelist validated
    const SUPPORTED_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
    const rawSymbol = (signal.symbol || 'ETHUSDT').toUpperCase();
    const symbol = SUPPORTED_SYMBOLS.includes(rawSymbol) ? rawSymbol : 'ETHUSDT';
    if (rawSymbol !== symbol) _log.warn('unknown_symbol', { module: 'bitget_exec', rawSymbol: signal.symbol, fallback: symbol });
    const leverage = String(config.SCALING?.leverage || config.MOMENTUM?.leverage || 10);

    // Smart order type: confidence >= 80 → market, 60-80 → limit
    const useLimit = confidence >= 60 && confidence < 80;
    const orderType = useLimit ? 'limit' : 'market';

    try {
      // Check existing positions — don't double up
      try {
        const posData = await bitgetRequest('GET', '/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT');
        const positions = Array.isArray(posData) ? posData : (posData?.list || []);
        const sameDirection = positions.find(p => p.symbol === symbol && p.holdSide === holdSide && parseFloat(p.total || '0') > 0);
        if (sameDirection) {
          _log.info('position_exists', { module: 'bitget_exec', holdSide, symbol });
          return;
        }
      } catch {}

      // Check pending orders — max 2
      try {
        const pendingData = await bitgetRequest('GET', '/api/v2/mix/order/orders-pending?productType=USDT-FUTURES');
        const allPending = pendingData?.entrustedList || (Array.isArray(pendingData) ? pendingData : []);
        const pendingCount = allPending.filter(o => o.orderType !== 'plan').length;
        if (useLimit && pendingCount >= 2) {
          _log.info('pending_orders_limit', { module: 'bitget_exec', pendingCount });
          return;
        }
      } catch {}

      // Check balance
      const accounts = await bitgetRequest('GET', '/api/v2/mix/account/accounts?productType=USDT-FUTURES');
      const usdtBal = accounts?.find(a => a.marginCoin === 'USDT');
      const available = parseFloat(usdtBal?.crossedMaxAvailable || usdtBal?.available || '0');

      if (available < 0.5) {
        _log.info('insufficient_balance', { module: 'bitget_exec', available: available.toFixed(2) });
        insertDecision.run(new Date().toISOString(), 'executor', 'skip', '', '',
          JSON.stringify({ reason: 'insufficient_balance', available }), 'Bitget trade skipped', '', '', confidence, null);
        return;
      }

      // Get current price for Kelly sizing + limit order price
      let currentPrice = 0;
      try {
        const ticker = await bitgetRequest('GET', `/api/v2/mix/market/ticker?symbol=${symbol}&productType=USDT-FUTURES`);
        const t = Array.isArray(ticker) ? ticker[0] : ticker;
        currentPrice = parseFloat(t?.lastPr || '0');
      } catch {}
      if (!currentPrice) {
        const pairMap = { BTCUSDT: 'BTC-USDT', ETHUSDT: 'ETH-USDT', SOLUSDT: 'SOL-USDT' };
        if (!pairMap[symbol]) {
          _log.error('no_price_mapping', { module: 'bitget_exec', symbol });
          return;
        }
        const candleRow = db.prepare('SELECT close FROM candles WHERE pair = ? ORDER BY ts_start DESC LIMIT 1').get(pairMap[symbol]);
        currentPrice = candleRow?.close || 0;
      }
      if (!currentPrice) {
        _log.error('price_unavailable', { module: 'bitget_exec', symbol });
        return;
      }

      // Dynamic Kelly position sizing (per-symbol)
      const kellySize = calculateKellySize(available, symbol, currentPrice);
      if (kellySize <= 0) {
        _log.info('kelly_zero', { module: 'bitget_exec', symbol });
        return;
      }
      const size = String(kellySize);

      // Set leverage
      await bitgetRequest('POST', '/api/v2/mix/account/set-leverage', {
        symbol, productType: 'USDT-FUTURES', marginCoin: 'USDT', leverage, holdSide,
      }).catch(() => {});

      // Build order params
      const orderParams = {
        symbol, productType: 'USDT-FUTURES', marginMode: 'crossed', marginCoin: 'USDT',
        side, tradeSide, orderType, size,
      };

      // Limit order: use entry_zone midpoint from analyst, within 1% of current price
      if (useLimit) {
        let limitPrice;
        if (signal.entry_zone && signal.entry_zone.low && signal.entry_zone.high) {
          const entryMid = (signal.entry_zone.low + signal.entry_zone.high) / 2;
          const deviation = Math.abs(entryMid - currentPrice) / currentPrice;
          limitPrice = deviation <= 0.01 ? entryMid : (isBuy ? currentPrice * 0.995 : currentPrice * 1.005);
        } else {
          // No entry_zone from analyst — place near current price
          limitPrice = isBuy ? currentPrice * 0.995 : currentPrice * 1.005;
        }
        orderParams.price = String(await roundPrice(symbol, limitPrice));
      }

      // Attach TP/SL from analyst signal — validate direction
      if (signal.take_profit && signal.stop_loss) {
        const tp = parseFloat(signal.take_profit);
        const sl = parseFloat(signal.stop_loss);
        const valid = isBuy ? (tp > currentPrice && sl < currentPrice) : (tp < currentPrice && sl > currentPrice);
        if (valid) {
          orderParams.presetStopSurplusPrice = String(await roundPrice(symbol, tp));
          orderParams.presetStopLossPrice = String(await roundPrice(symbol, sl));
        } else {
          _log.warn('invalid_tp_sl_direction', { module: 'bitget_exec', holdSide, tp, sl, currentPrice });
        }
      }

      // Place order
      const order = await bitgetRequest('POST', '/api/v2/mix/order/place-order', orderParams);

      const orderId = order?.orderId;
      const priceInfo = useLimit ? `@ ${orderParams.price}` : '@ market';
      _log.info('trade_opened', { module: 'bitget_exec', holdSide, size, symbol, leverage, orderType, priceInfo, confidence, sl: signal.stop_loss || '-', tp: signal.take_profit || '-', orderId });
      metrics?.record('trade_execution', 1, { symbol, side, orderType });

      // Record trade
      insertTrade.run(
        `bg_${orderId}`, 'bitget', symbol, side, useLimit ? parseFloat(orderParams.price) : 0, parseFloat(size), 0,
        parseInt(leverage, 10), 'open', orderId || '', JSON.stringify(signal),
        `${action} conf:${confidence} ${orderType}`, new Date().toISOString()
      );

      insertDecision.run(new Date().toISOString(), 'executor', 'bitget_trade', 'place-order',
        JSON.stringify({ symbol, side, size, leverage, orderType, price: orderParams.price || 'market' }),
        JSON.stringify(order), `Bitget ${holdSide} ${symbol} ${orderType}`, '', '', confidence, `bg_${orderId}`);

      postMessage('executor', 'reviewer', 'TRADE_RESULT', { source: 'bitget', orderId, symbol, side, size, orderType }, traceId);

      // Fetch actual fill price (market: 3s, limit: 60s to allow fill time)
      if (orderId) {
        const delay = orderType === 'market' ? 3000 : 60000;
        setTimeout(() => _fetchAndUpdateEntryPrice(orderId, symbol, `bg_${orderId}`), delay);
      }

    } catch (err) {
      _log.error('trade_failed', { module: 'bitget_exec', error: err.message });
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
        _log.info('entry_price_updated', { module: 'trade_sync', tradeId, fillPrice });
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
              _log.info('pending_limit_order', { module: 'trade_sync', tradeId: trade.trade_id, orderStatus });
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

          // Fetch actual fill price from Bitget — covers limit orders with price improvement
          // and market orders where initial 3s fetch failed
          if (trade.tx_hash) {
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
          _log.info('trade_closed', { module: 'trade_sync', tradeId: trade.trade_id, entryPrice, exitPrice, pnl: pnl.toFixed(4), pnlPct: pnlPct.toFixed(2) });

          // Trigger reviewer to generate lesson from this closed trade
          if (reviewer) {
            reviewer.runReview(`sync_close_${trade.trade_id}`).catch(err =>
              _log.error('reviewer_trigger_failed', { module: 'trade_sync', error: err.message })
            );
          }
        } catch {
          // Can't find fill data — mark closed to avoid re-checking indefinitely
          updateTradeClose.run(0, 0, 0, new Date().toISOString(), trade.trade_id);
          _log.info('trade_closed_no_fill', { module: 'trade_sync', tradeId: trade.trade_id });
        }
      }
    } catch (e) {
      _log.error('sync_error', { module: 'trade_sync', error: e.message });
    }
  }

  // ──────── Graduated Position Scaling ────────

  function _getSymbolPrice(symbol) {
    // Map ETHUSDT → ETH-USDT for candles table
    const pair = symbol.replace('USDT', '-USDT');
    const row = db.prepare('SELECT close FROM candles WHERE pair = ? ORDER BY ts_start DESC LIMIT 1').get(pair);
    return row?.close || 0;
  }

  function _calcLevelSize(level, maxKellySize) {
    const totalRatio = SCALING.ratios.reduce((s, r) => s + r, 0);
    return parseFloat((SCALING.ratios[level] / totalRatio * maxKellySize).toFixed(4));
  }

  function _calcMaxKellySize(available, symbol) {
    const price = _getSymbolPrice(symbol);
    if (!price) return 0.01;
    // Full Kelly with per-symbol history and current price for correct sizing
    const kellyFull = calculateKellySize(available, symbol, price);
    // Kelly already returns half-Kelly capped at 25% of equity → that's our max
    return kellyFull;
  }

  function _calcStopLoss(side, avgEntry, level) {
    const pct = SCALING.stop_loss_pcts[level] / 100;
    return side === 'long'
      ? parseFloat((avgEntry * (1 - pct)).toFixed(2))
      : parseFloat((avgEntry * (1 + pct)).toFixed(2));
  }

  function _calcWeightedAvgEntry(existingAvg, existingSize, newPrice, newSize) {
    const totalSize = existingSize + newSize;
    if (totalSize === 0) return newPrice;
    return (existingAvg * existingSize + newPrice * newSize) / totalSize;
  }

  async function openScoutPosition(symbol, signal, traceId) {
    if (!config.BITGET_API_KEY) return null;
    if (!tradingLock.acquire()) { _log.info('trading_lock_active', { module: 'scout' }); return null; }

    try {
      // Check abandon cooldown
      const lastAbandoned = getLastAbandonedTime(symbol);
      if (Date.now() - lastAbandoned < SCALING.abandon_cooldown_ms) {
        _log.info('abandon_cooldown', { module: 'scout', symbol });
        return null;
      }

      // Check no existing active group for this symbol
      if (getActiveGroup(symbol)) {
        _log.info('active_group_exists', { module: 'scout', symbol });
        return null;
      }

      const action = signal.recommended_action;
      const isBuy = ['strong_buy', 'increase_exposure'].includes(action);
      const side = isBuy ? 'buy' : 'sell';
      const holdSide = isBuy ? 'long' : 'short';
      const leverage = String(SCALING?.leverage || config.MOMENTUM?.leverage || 10);

      // Check balance
      const accounts = await bitgetRequest('GET', '/api/v2/mix/account/accounts?productType=USDT-FUTURES');
      const usdtBal = accounts?.find(a => a.marginCoin === 'USDT');
      const available = parseFloat(usdtBal?.crossedMaxAvailable || usdtBal?.available || '0');
      if (available < 0.5) {
        _log.info('insufficient_balance', { module: 'scout', available: available.toFixed(2) });
        return null;
      }

      // Check existing Bitget positions for same direction
      try {
        const posData = await bitgetRequest('GET', '/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT');
        const positions = Array.isArray(posData) ? posData : (posData?.list || []);
        if (positions.find(p => p.symbol === symbol && p.holdSide === holdSide && parseFloat(p.total || '0') > 0)) {
          _log.info('position_exists', { module: 'scout', holdSide, symbol });
          return null;
        }
      } catch {}

      // Calculate sizes
      const maxKelly = _calcMaxKellySize(available, symbol);
      const scoutSize = Math.max(0.01, _calcLevelSize(0, maxKelly));
      const sizeStr = String(scoutSize);

      // Set leverage
      await bitgetRequest('POST', '/api/v2/mix/account/set-leverage', {
        symbol, productType: 'USDT-FUTURES', marginCoin: 'USDT', leverage, holdSide,
      }).catch(() => {});

      // Place market order
      const order = await bitgetRequest('POST', '/api/v2/mix/order/place-order', {
        symbol, productType: 'USDT-FUTURES', marginMode: 'crossed', marginCoin: 'USDT',
        side, tradeSide: 'open', orderType: 'market', size: sizeStr,
      });

      const orderId = order?.orderId;
      const price = _getSymbolPrice(symbol);
      const stopLoss = _calcStopLoss(holdSide, price, 0);
      const tp = signal.take_profit || null;

      _log.info('scout_opened', { module: 'scout', level: 0, holdSide, size: sizeStr, symbol, orderId, stopLoss });
      metrics?.record('trade_execution', 1, { symbol, side, orderType: 'market' });

      // Record in trades table (backward compat)
      const tradeId = `bg_${orderId}`;
      insertTrade.run(tradeId, 'bitget', symbol, side, 0, scoutSize, 0, 10, 'open', orderId || '',
        JSON.stringify(signal), `scout L0 ${action} conf:${signal.confidence}`, new Date().toISOString());

      // Create position group
      const groupResult = insertPositionGroup.run(symbol, holdSide, price, scoutSize, maxKelly, stopLoss, tp);
      const groupId = groupResult.lastInsertRowid;

      // Record level
      insertPositionLevel.run(groupId, 0, tradeId, orderId, scoutSize, price, signal.confidence, action);

      insertDecision.run(new Date().toISOString(), 'executor', 'scout_open', 'place-order',
        JSON.stringify({ symbol, side, size: sizeStr, leverage, level: 0 }),
        JSON.stringify(order), `Scout L0 ${holdSide} ${symbol}`, '', '', signal.confidence, tradeId);

      postMessage('executor', 'reviewer', 'TRADE_RESULT', { source: 'bitget', orderId, symbol, side, size: sizeStr, level: 0 }, traceId);

      // Fetch fill price
      if (orderId) {
        setTimeout(async () => {
          await _fetchAndUpdateEntryPrice(orderId, symbol, tradeId);
          // Also update position group avg_entry
          try {
            const detail = await bitgetRequest('GET', `/api/v2/mix/order/detail?symbol=${symbol}&productType=USDT-FUTURES&orderId=${orderId}`);
            const fillPrice = parseFloat(detail?.priceAvg || detail?.fillPrice || '0');
            if (fillPrice > 0) {
              const newSL = _calcStopLoss(holdSide, fillPrice, 0);
              updatePositionGroup.run(0, fillPrice, scoutSize, newSL, tp, groupId);
              db.prepare('UPDATE position_levels SET entry_price = ? WHERE group_id = ? AND level = 0').run(fillPrice, groupId);
            }
          } catch {}
        }, 3000);
      }

      return { groupId, level: 0, size: scoutSize, symbol, holdSide };
    } catch (err) {
      _log.error('scout_failed', { module: 'scout', error: err.message });
      insertDecision.run(new Date().toISOString(), 'executor', 'scout_error', '', '',
        JSON.stringify({ error: err.message }), 'Scout open failed', err.message, '', 0, null);
      return null;
    } finally {
      tradingLock.release();
    }
  }

  function checkScaleUpConditions(group, signal, currentPrice) {
    const nextLevel = group.current_level + 1;
    if (nextLevel >= SCALING.ratios.length) return false; // already max level

    // Confidence check
    if ((signal.confidence || 0) < SCALING.confidence_thresholds[nextLevel]) return false;

    // Action requirement check
    const action = signal.recommended_action;
    if (!SCALING.action_requirements[nextLevel].includes(action)) return false;

    // Direction check — signal must agree with position direction
    const isBuySignal = ['strong_buy', 'increase_exposure'].includes(action);
    const isLongPos = group.side === 'long';
    if (isBuySignal !== isLongPos) return false;

    // Price confirmation check
    const requiredPct = SCALING.price_confirm_pcts[nextLevel]; // already a fraction (0.003 = 0.3%)
    if (requiredPct > 0 && group.avg_entry_price > 0 && currentPrice > 0) {
      const priceMoved = isLongPos
        ? (currentPrice - group.avg_entry_price) / group.avg_entry_price
        : (group.avg_entry_price - currentPrice) / group.avg_entry_price;
      if (priceMoved < requiredPct) return false;
    }

    // Max exposure check
    const totalRatio = SCALING.ratios.reduce((s, r) => s + r, 0);
    const nextSize = _calcLevelSize(nextLevel, group.max_kelly_size);
    if (group.total_size + nextSize > SCALING.max_exposure_eth) return false;

    return true;
  }

  async function scaleUpPosition(group, signal, traceId) {
    if (!tradingLock.acquire()) { _log.info('trading_lock_active', { module: 'scale_up' }); return null; }

    try {
      const nextLevel = group.current_level + 1;
      const size = Math.max(0.01, _calcLevelSize(nextLevel, group.max_kelly_size));
      const sizeStr = String(size);
      const side = group.side === 'long' ? 'buy' : 'sell';
      const holdSide = group.side;

      // Set leverage
      await bitgetRequest('POST', '/api/v2/mix/account/set-leverage', {
        symbol: group.symbol, productType: 'USDT-FUTURES', marginCoin: 'USDT', leverage: String(SCALING?.leverage || config.MOMENTUM?.leverage || 10), holdSide,
      }).catch(() => {});

      // Place order
      const order = await bitgetRequest('POST', '/api/v2/mix/order/place-order', {
        symbol: group.symbol, productType: 'USDT-FUTURES', marginMode: 'crossed', marginCoin: 'USDT',
        side, tradeSide: 'open', orderType: 'market', size: sizeStr,
      });

      const orderId = order?.orderId;
      const currentPrice = _getSymbolPrice(group.symbol);

      // Update weighted average entry
      const newAvgEntry = _calcWeightedAvgEntry(group.avg_entry_price, group.total_size, currentPrice, size);
      const newTotalSize = group.total_size + size;
      const newSL = _calcStopLoss(holdSide, newAvgEntry, nextLevel);
      const tp = group.take_profit; // keep existing TP

      _log.info('scale_up_opened', { module: 'scale_up', level: nextLevel, holdSide, size: sizeStr, symbol: group.symbol, totalSize: newTotalSize.toFixed(4), avgEntry: newAvgEntry.toFixed(2), stopLoss: newSL });
      metrics?.record('trade_execution', 1, { symbol: group.symbol, side, orderType: 'market' });

      // Record in trades table
      const tradeId = `bg_${orderId}`;
      insertTrade.run(tradeId, 'bitget', group.symbol, side, currentPrice, size, 0, 10, 'open', orderId || '',
        JSON.stringify(signal), `scaleUp L${nextLevel} conf:${signal.confidence}`, new Date().toISOString());

      // Update position group
      updatePositionGroup.run(nextLevel, newAvgEntry, newTotalSize, newSL, tp, group.id);

      // Record level
      insertPositionLevel.run(group.id, nextLevel, tradeId, orderId, size, currentPrice, signal.confidence, signal.recommended_action);

      insertDecision.run(new Date().toISOString(), 'executor', 'scale_up', 'place-order',
        JSON.stringify({ symbol: group.symbol, side, size: sizeStr, level: nextLevel, avgEntry: newAvgEntry }),
        JSON.stringify(order), `ScaleUp L${nextLevel} ${holdSide} ${group.symbol}`, '', '', signal.confidence, tradeId);

      postMessage('executor', 'reviewer', 'TRADE_RESULT', {
        source: 'bitget', orderId, symbol: group.symbol, side, size: sizeStr, level: nextLevel
      }, traceId);

      // Fetch fill price and update avg
      if (orderId) {
        setTimeout(async () => {
          await _fetchAndUpdateEntryPrice(orderId, group.symbol, tradeId);
          try {
            const detail = await bitgetRequest('GET', `/api/v2/mix/order/detail?symbol=${group.symbol}&productType=USDT-FUTURES&orderId=${orderId}`);
            const fillPrice = parseFloat(detail?.priceAvg || detail?.fillPrice || '0');
            if (fillPrice > 0) {
              const correctedAvg = _calcWeightedAvgEntry(group.avg_entry_price, group.total_size, fillPrice, size);
              const correctedSL = _calcStopLoss(holdSide, correctedAvg, nextLevel);
              updatePositionGroup.run(nextLevel, correctedAvg, newTotalSize, correctedSL, tp, group.id);
              db.prepare('UPDATE position_levels SET entry_price = ? WHERE group_id = ? AND level = ?').run(fillPrice, group.id, nextLevel);
            }
          } catch {}
        }, 3000);
      }

      return { level: nextLevel, size, avgEntry: newAvgEntry };
    } catch (err) {
      _log.error('scale_up_failed', { module: 'scale_up', error: err.message });
      return null;
    } finally {
      tradingLock.release();
    }
  }

  function checkAbandonConditions(group, signal, currentPrice) {
    if (!currentPrice || !group.avg_entry_price) return false;

    // 1. Stop-loss hit
    if (group.stop_loss) {
      if (group.side === 'long' && currentPrice <= group.stop_loss) return true;
      if (group.side === 'short' && currentPrice >= group.stop_loss) return true;
    }

    // 2. Strong opposite signal
    const action = signal.recommended_action;
    const confidence = signal.confidence || 0;
    const isBuySignal = ['strong_buy', 'increase_exposure'].includes(action);
    const isLongPos = group.side === 'long';

    // strong_sell on a long position (or vice versa) with high confidence → abandon
    if (confidence >= 70 && isBuySignal !== isLongPos &&
        ['strong_buy', 'strong_sell'].includes(action)) {
      return true;
    }

    return false;
  }

  async function abandonPosition(group, traceId) {
    if (!tradingLock.acquire()) { _log.info('trading_lock_active', { module: 'abandon' }); return; }

    try {
      const closeSide = group.side === 'long' ? 'sell' : 'buy';
      const holdSide = group.side;

      // Use actual exchange position size (may differ from DB due to rounding)
      let closeSize = group.total_size;
      try {
        const posData = await bitgetRequest('GET', '/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT');
        const positions = Array.isArray(posData) ? posData : (posData?.list || []);
        const pos = positions.find(p => p.symbol === group.symbol && p.holdSide === holdSide);
        if (pos && parseFloat(pos.total || '0') > 0) closeSize = parseFloat(pos.total);
      } catch {}
      const totalSize = String(closeSize);

      // Close entire position with one market order
      const order = await bitgetRequest('POST', '/api/v2/mix/order/place-order', {
        symbol: group.symbol, productType: 'USDT-FUTURES', marginMode: 'crossed', marginCoin: 'USDT',
        side: closeSide, tradeSide: 'close', orderType: 'market', size: totalSize,
      });

      const currentPrice = _getSymbolPrice(group.symbol);
      const direction = group.side === 'long' ? 1 : -1;
      const pnl = direction * (currentPrice - group.avg_entry_price) * group.total_size;
      const pnlPct = group.avg_entry_price > 0
        ? direction * (currentPrice - group.avg_entry_price) / group.avg_entry_price * 10 * 100
        : 0;

      const sign = pnl >= 0 ? '+' : '';
      _log.info('position_abandoned', { module: 'abandon', holdSide, symbol: group.symbol, level: group.current_level, size: totalSize, pnl: pnl.toFixed(4), pnlPct: pnlPct.toFixed(2) });

      // Close the position group
      closePositionGroup.run('abandoned', pnl, pnlPct, group.id);

      // Close all associated trades — distribute PnL proportional to each level's size
      const levels = getGroupLevels(group.id);
      for (const lvl of levels) {
        if (lvl.trade_id) {
          const lvlPnl = group.total_size > 0 ? pnl * (lvl.size / group.total_size) : 0;
          updateTradeClose.run(currentPrice, lvlPnl, pnlPct, new Date().toISOString(), lvl.trade_id);
        }
      }

      insertDecision.run(new Date().toISOString(), 'executor', 'abandon', 'close-all',
        JSON.stringify({ symbol: group.symbol, side: closeSide, size: totalSize, level: group.current_level }),
        JSON.stringify(order), `Abandon ${holdSide} ${group.symbol}`, '', `pnl=${sign}${pnl.toFixed(4)}`, 0, null);

    } catch (err) {
      _log.error('abandon_failed', { module: 'abandon', error: err.message });
    } finally {
      tradingLock.release();
    }
  }

  return {
    executeBitgetTrade, tradingLock, checkAndSyncTrades,
    // Scaling API
    openScoutPosition, scaleUpPosition, abandonPosition,
    checkScaleUpConditions, checkAbandonConditions,
    getActiveGroup: (symbol) => getActiveGroup(symbol),
  };
}
