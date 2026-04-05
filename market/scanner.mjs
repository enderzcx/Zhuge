/**
 * Market scanner: opportunity detection + pending order review + momentum coin discovery & trading.
 */

import { calcRSI, calcBollinger } from './indicators.mjs';

export function createScanner({ db, config, bitgetClient, agentRunner, indicators, tradingLock, researcher, compound }) {
  const { bitgetPublic, bitgetRequest, roundPrice } = bitgetClient;
  const { runAgent } = agentRunner;
  const { insertDecision, insertTrade, insertCandidate, updateCandidateResearch, markCandidateTraded } = db;
  const MOMENTUM = config.MOMENTUM;

  // Cache known symbols to detect new listings
  let _knownSymbols = new Set();
  let _bootCycles = 0;

  /**
   * Scan market for opportunities — returns data for analyst, does NOT place trades.
   */
  async function scanMarketOpportunities() {
    if (!config.BITGET_API_KEY) return [];
    console.log('[Scanner] Scanning futures market...');

    try {
      const tickers = await bitgetPublic('/api/v2/mix/market/tickers?productType=USDT-FUTURES');
      if (!tickers?.length) return [];

      const candidates = tickers.filter(t => {
        const vol = parseFloat(t.usdtVolume || 0);
        const chg = Math.abs(parseFloat(t.change24h || 0));
        return vol > 5000000 && chg > 0.02;
      }).map(t => ({
        symbol: t.symbol,
        price: parseFloat(t.lastPr),
        change24h: parseFloat(t.change24h),
        volume: parseFloat(t.usdtVolume),
        fundingRate: parseFloat(t.fundingRate || 0),
        high24h: parseFloat(t.high24h),
        low24h: parseFloat(t.low24h),
      })).sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h));

      const opportunities = [];
      for (const c of candidates.slice(0, 10)) {
        try {
          const candles = await bitgetPublic(`/api/v2/mix/market/candles?symbol=${c.symbol}&productType=USDT-FUTURES&granularity=1H&limit=50`);
          if (!candles?.length) continue;

          const closes = candles.map(k => parseFloat(k[4])).reverse();
          const highs = candles.map(k => parseFloat(k[2])).reverse();
          const lows = candles.map(k => parseFloat(k[3])).reverse();

          const rsi = calcRSI(closes, 14);
          const ma20 = closes.length >= 20 ? closes.slice(-20).reduce((s, v) => s + v, 0) / 20 : null;
          const ma50 = closes.length >= 50 ? closes.slice(-50).reduce((s, v) => s + v, 0) / 50 : null;
          const bb = calcBollinger(closes, 20);
          const support = Math.min(...lows.slice(-20));
          const resistance = Math.max(...highs.slice(-20));

          opportunities.push({
            ...c,
            rsi, ma20, ma50, bb, support, resistance,
            signal: rsi < 30 ? 'oversold' : rsi > 70 ? 'overbought' : 'neutral',
            trend: ma20 && ma50 ? (ma20 > ma50 ? 'bullish' : 'bearish') : 'unknown',
          });
        } catch {}
      }

      console.log(`[Scanner] Found ${opportunities.length} opportunities from ${candidates.length} candidates`);
      return opportunities;
    } catch (err) {
      console.error('[Scanner] Error:', err.message);
      return [];
    }
  }

  /**
   * Review and clean up pending limit orders.
   * Still needed: executor now places limit orders for confidence 60-80.
   */
  async function reviewPendingOrders() {
    if (!config.BITGET_API_KEY) return;
    console.log('[PendingReview] Reviewing pending orders...');

    try {
      const pendingData = await bitgetRequest('GET', '/api/v2/mix/order/orders-pending?productType=USDT-FUTURES');
      const allPending = pendingData?.entrustedList || (Array.isArray(pendingData) ? pendingData : []);

      const limitOrders = allPending.filter(o => o.orderType !== 'plan');
      if (!limitOrders.length) {
        console.log('[PendingReview] No pending limit orders to review');
        return;
      }
      console.log(`[PendingReview] ${limitOrders.length} pending limit order(s) to review`);

      let positions = [];
      try {
        const posData = await bitgetRequest('GET', '/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT');
        positions = Array.isArray(posData) ? posData : (posData?.list || []);
      } catch {}

      const positionSymbols = new Set(
        positions.filter(p => parseFloat(p.total || '0') > 0).map(p => `${p.symbol}_${p.holdSide}`)
      );

      const symbols = [...new Set(limitOrders.map(o => o.symbol))];
      const priceMap = {};
      try {
        const tickers = await bitgetPublic('/api/v2/mix/market/tickers?productType=USDT-FUTURES');
        if (Array.isArray(tickers)) {
          for (const t of tickers) {
            if (symbols.includes(t.symbol)) priceMap[t.symbol] = parseFloat(t.lastPr);
          }
        }
      } catch {}

      const now = Date.now();
      const ORDER_EXPIRY_MS = 1.5 * 60 * 60 * 1000;
      const PRICE_DEVIATION_THRESHOLD = 0.025;

      const toCancel = [];
      const toKeep = [];

      for (const order of limitOrders) {
        const orderAge = now - parseInt(order.cTime || order.ctime || '0', 10);
        const orderPrice = parseFloat(order.price);
        const currentPrice = priceMap[order.symbol];
        const holdSide = order.side === 'buy' ? 'long' : 'short';
        const posKey = `${order.symbol}_${holdSide}`;

        let cancelReason = null;

        if (orderAge > ORDER_EXPIRY_MS) {
          cancelReason = 'expired_90min';
        } else if (currentPrice && orderPrice > 0) {
          const deviation = Math.abs(currentPrice - orderPrice) / orderPrice;
          if (deviation > PRICE_DEVIATION_THRESHOLD) {
            cancelReason = `price_deviation_${(deviation * 100).toFixed(1)}pct`;
          }
        }
        const isOpenOrder = order.tradeSide === 'open' || !order.tradeSide;
        if (!cancelReason && isOpenOrder && positionSymbols.has(posKey)) {
          cancelReason = 'duplicate_position';
        }

        if (cancelReason) {
          toCancel.push({ order, reason: cancelReason });
        } else {
          toKeep.push(order);
        }
      }

      // LLM review if 2+ orders remain after auto-cancel
      let llmCancelIds = new Set();
      if (toKeep.length >= 2) {
        console.log(`[PendingReview] ${toKeep.length} orders surviving auto-cancel, asking LLM...`);
        try {
          const orderSummary = toKeep.map(o => ({
            orderId: o.orderId, symbol: o.symbol, side: o.side,
            orderPrice: parseFloat(o.price), currentPrice: priceMap[o.symbol] || null,
            size: o.size, ageMinutes: Math.round((now - parseInt(o.cTime || o.ctime || '0', 10)) / 60000),
          }));

          const prompt = `You are a trading analyst. Review these pending limit orders and decide which to cancel.

Pending orders:
${JSON.stringify(orderSummary, null, 2)}

Rules:
- Keep orders where entry price is still close to current market structure
- Cancel orders where the market has moved strongly away (entry no longer makes sense)
- Cancel redundant orders for the same symbol/direction
- Respond with JSON only: { "cancel": ["orderId1", "orderId2"], "reason": "brief explanation in Chinese" }`;

          const result = await runAgent('executor', prompt, [], {}, 'Review pending orders', {
            max_tokens: 400, timeout: 45000, model: config.AGENT_MODELS?.analyst,
          });

          const jsonStr = result.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          const parsed = JSON.parse(jsonStr);
          llmCancelIds = new Set(parsed.cancel || []);
          console.log(`[PendingReview] LLM wants to cancel ${llmCancelIds.size} orders: ${parsed.reason}`);
        } catch (e) {
          console.warn('[PendingReview] LLM review failed, proceeding with auto-cancel only:', e.message);
        }
      }

      const allToCancel = [
        ...toCancel,
        ...toKeep.filter(o => llmCancelIds.has(o.orderId)).map(o => ({ order: o, reason: 'llm_review' })),
      ];

      for (const { order, reason } of allToCancel) {
        try {
          await bitgetRequest('POST', '/api/v2/mix/order/cancel-order', {
            symbol: order.symbol, productType: 'USDT-FUTURES', orderId: order.orderId,
          });
          console.log(`[PendingReview] Cancelled ${order.symbol} ${order.side} @ ${order.price} | reason: ${reason}`);

          insertDecision.run(
            new Date().toISOString(), 'scanner', 'cancel_pending', 'cancel-order',
            JSON.stringify({ symbol: order.symbol, side: order.side, price: order.price, orderId: order.orderId }),
            JSON.stringify({ reason }), `Pending order cancelled: ${reason}`, '', '', 0, null
          );

          await new Promise(r => setTimeout(r, 100));
        } catch (e) {
          console.error(`[PendingReview] Cancel failed for ${order.orderId}:`, e.message);
        }
      }

      console.log(`[PendingReview] Done. Cancelled: ${allToCancel.length}, Kept: ${limitOrders.length - allToCancel.length}`);
    } catch (err) {
      console.error('[PendingReview] Error:', err.message);
    }
  }

  // ──────── Momentum: New Coin Discovery & Research Trading ────────

  /**
   * Discover new/trending coins on Bitget futures.
   * Returns array of candidate objects for research.
   */
  async function discoverNewCoins() {
    if (!MOMENTUM?.enabled || !config.BITGET_API_KEY) return [];
    console.log('[Discovery] Scanning for new/trending coins...');

    try {
      const tickers = await bitgetPublic('/api/v2/mix/market/tickers?productType=USDT-FUTURES');
      if (!tickers?.length) return [];

      const currentSymbols = new Set(tickers.map(t => t.symbol));
      const exclude = new Set(MOMENTUM.exclude_symbols);

      // Detect brand new listings (not in our known set)
      // Skip on first 2 cycles after boot to avoid false positives
      const newListings = [];
      if (_knownSymbols.size > 0 && _bootCycles >= 2) {
        for (const sym of currentSymbols) {
          if (!_knownSymbols.has(sym) && !exclude.has(sym)) {
            const t = tickers.find(x => x.symbol === sym);
            if (t) newListings.push({ symbol: sym, type: 'new_listing', ...parseTicker(t) });
          }
        }
        if (newListings.length > 0) console.log(`[Discovery] ${newListings.length} NEW listings: ${newListings.map(n => n.symbol).join(', ')}`);
      }
      _knownSymbols = currentSymbols;
      _bootCycles++;

      // Find trending coins: high volume + big move, excluding majors
      const trending = tickers
        .filter(t => {
          const vol = parseFloat(t.usdtVolume || 0);
          const chg = Math.abs(parseFloat(t.change24h || 0));
          return !exclude.has(t.symbol) && vol > MOMENTUM.volume_threshold && chg > MOMENTUM.change_threshold;
        })
        .map(t => ({ symbol: t.symbol, type: 'trending', ...parseTicker(t) }))
        .sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h))
        .slice(0, 8); // top 8 trending

      const candidates = [...newListings, ...trending];
      // Deduplicate by symbol
      const seen = new Set();
      const unique = candidates.filter(c => {
        if (seen.has(c.symbol)) return false;
        seen.add(c.symbol);
        return true;
      });

      // Persist to DB
      const now = new Date().toISOString();
      for (const c of unique) {
        try {
          insertCandidate.run(c.symbol, c.type, c.volume, c.change24h, c.price, c.fundingRate, now);
        } catch {} // ignore duplicate
      }

      console.log(`[Discovery] Found ${newListings.length} new + ${trending.length} trending = ${unique.length} candidates`);
      return unique;
    } catch (err) {
      console.error('[Discovery] Error:', err.message);
      return [];
    }
  }

  function parseTicker(t) {
    return {
      price: parseFloat(t.lastPr || 0),
      change24h: parseFloat(t.change24h || 0),
      volume: parseFloat(t.usdtVolume || 0),
      fundingRate: parseFloat(t.fundingRate || 0),
      high24h: parseFloat(t.high24h || 0),
      low24h: parseFloat(t.low24h || 0),
    };
  }

  /**
   * Run research + trade for discovered candidates.
   */
  async function runMomentumPipeline() {
    if (!MOMENTUM?.enabled || !researcher) return;

    // 1. Discover
    const candidates = await discoverNewCoins();
    if (!candidates.length) return;

    // 2. Check how many momentum trades are already open
    const openMomentum = db.prepare(
      "SELECT COUNT(*) as cnt FROM trades WHERE status = 'open' AND trade_id LIKE 'res_%'"
    ).get();
    const maxOpen = _overrides.max_open || MOMENTUM.max_open;
    if (openMomentum.cnt >= maxOpen) {
      console.log(`[Momentum] Already ${openMomentum.cnt} open momentum trades (max ${maxOpen}), skip`);
      return;
    }

    // 3. Check 24h momentum losses
    const losses24h = db.prepare(
      "SELECT COALESCE(SUM(ABS(pnl)), 0) as total_loss FROM trades WHERE status = 'closed' AND pnl < 0 AND trade_id LIKE 'res_%' AND closed_at > datetime('now', '-1 day')"
    ).get();
    const _overrides = compound?.getParamOverrides?.() || {};
    const maxLoss = _overrides.max_daily_loss || MOMENTUM.max_daily_loss;
    if (losses24h.total_loss >= maxLoss) {
      console.log(`[Momentum] 24h loss $${losses24h.total_loss.toFixed(2)} >= max $${maxLoss}, pause`);
      return;
    }

    // 4. Research top candidates (limit to 3 to save tokens)
    let slotsAvailable = maxOpen - openMomentum.cnt;
    const toResearch = candidates.slice(0, Math.min(3, candidates.length));

    for (const candidate of toResearch) {
      if (slotsAvailable <= 0) break;

      try {
        const report = await researcher.researchCoin(candidate.symbol, candidate);
        if (!report) continue;

        // Update candidate record
        const candidateRow = db.prepare(
          "SELECT id FROM coin_candidates WHERE symbol = ? ORDER BY discovered_at DESC LIMIT 1"
        ).get(candidate.symbol);
        if (candidateRow) {
          updateCandidateResearch.run(report.total_score, report.verdict, JSON.stringify(report), new Date().toISOString(), candidateRow.id);
        }

        // 5. Execute if TRADE verdict + score threshold
        const minScore = _overrides.min_score || MOMENTUM.min_score;
        if (report.verdict === 'TRADE' && report.total_score >= minScore && report.direction) {
          const traded = await executeMomentumTrade(candidate.symbol, report);
          if (traded) {
            slotsAvailable--;
            if (candidateRow) markCandidateTraded.run(candidateRow.id);
          }
        }
      } catch (err) {
        console.error(`[Momentum] ${candidate.symbol} research/trade error:`, err.message);
      }
    }
  }

  /**
   * Execute a momentum trade based on research report.
   */
  async function executeMomentumTrade(symbol, report) {
    if (!tradingLock || !tradingLock.acquire()) {
      console.log('[Momentum] Trading lock active, skip');
      return false;
    }

    try {
      const isBuy = report.direction === 'long';
      const side = isBuy ? 'buy' : 'sell';
      const holdSide = isBuy ? 'long' : 'short';

      // Apply compound param overrides (AI-decided parameters)
      const overrides = compound?.getParamOverrides?.() || {};
      const leverage = String(overrides.leverage || MOMENTUM.leverage);

      // Check balance
      const accounts = await bitgetRequest('GET', '/api/v2/mix/account/accounts?productType=USDT-FUTURES');
      const usdtBal = accounts?.find(a => a.marginCoin === 'USDT');
      const available = parseFloat(usdtBal?.crossedMaxAvailable || usdtBal?.available || '0');
      const marginPerTrade = overrides.margin_per_trade || MOMENTUM.margin_per_trade;
      if (available < marginPerTrade) {
        console.log(`[Momentum] Insufficient margin: $${available.toFixed(2)} < $${marginPerTrade}`);
        return false;
      }

      // Check no duplicate position
      try {
        const posData = await bitgetRequest('GET', '/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT');
        const positions = Array.isArray(posData) ? posData : (posData?.list || []);
        if (positions.find(p => p.symbol === symbol && p.holdSide === holdSide && parseFloat(p.total || '0') > 0)) {
          console.log(`[Momentum] Already have ${holdSide} on ${symbol}, skip`);
          return false;
        }
      } catch {}

      // Get current price for sizing
      let currentPrice = 0;
      try {
        const ticker = await bitgetRequest('GET', `/api/v2/mix/market/ticker?symbol=${symbol}&productType=USDT-FUTURES`);
        const t = Array.isArray(ticker) ? ticker[0] : ticker;
        currentPrice = parseFloat(t?.lastPr || '0');
      } catch {}
      if (!currentPrice) {
        console.error(`[Momentum] No price for ${symbol}, abort`);
        return false;
      }

      // Calculate size: margin * leverage / price
      const effectiveLeverage = overrides.leverage || MOMENTUM.leverage;
      const notional = marginPerTrade * effectiveLeverage;
      const size = String(Math.max(parseFloat((notional / currentPrice).toFixed(4)), 0.01));

      // Set leverage
      await bitgetRequest('POST', '/api/v2/mix/account/set-leverage', {
        symbol, productType: 'USDT-FUTURES', marginCoin: 'USDT', leverage, holdSide,
      }).catch(() => {});

      // Build order with TP/SL
      const orderParams = {
        symbol, productType: 'USDT-FUTURES', marginMode: 'crossed', marginCoin: 'USDT',
        side, tradeSide: 'open', orderType: 'market', size,
      };

      // TP/SL — compound overrides or defaults
      const tpPct = overrides.tp_pct || 0.03;
      const slPct = overrides.sl_pct || 0.015;
      const tpRaw = isBuy ? currentPrice * (1 + tpPct) : currentPrice * (1 - tpPct);
      const slRaw = isBuy ? currentPrice * (1 - slPct) : currentPrice * (1 + slPct);
      const tp = await roundPrice(symbol, tpRaw);
      const sl = await roundPrice(symbol, slRaw);
      orderParams.presetStopSurplusPrice = String(tp);
      orderParams.presetStopLossPrice = String(sl);

      // Place order
      const order = await bitgetRequest('POST', '/api/v2/mix/order/place-order', orderParams);
      const orderId = order?.orderId;

      console.log(`[Momentum] ${holdSide.toUpperCase()} ${size} ${symbol} ${leverage}x MARKET @ $${currentPrice} | score:${report.total_score} | SL:$${sl} TP:$${tp} | orderId: ${orderId}`);

      // Record trade
      const tradeId = `res_${orderId || Date.now()}`;
      insertTrade.run(tradeId, 'bitget', symbol, side, currentPrice, parseFloat(size), 0,
        parseInt(leverage), 'open', orderId || '', JSON.stringify(report),
        `Momentum: score ${report.total_score}, ${report.reasoning?.slice(0, 100)}`, new Date().toISOString());

      insertDecision.run(new Date().toISOString(), 'researcher', 'momentum_trade', 'place-order',
        JSON.stringify({ symbol, side, size, leverage, score: report.total_score }),
        JSON.stringify(order), `Momentum ${holdSide} ${symbol}`, report.reasoning || '', '', report.total_score, tradeId);

      // Fetch fill price after 3s
      if (orderId) {
        setTimeout(async () => {
          try {
            const detail = await bitgetRequest('GET', `/api/v2/mix/order/detail?symbol=${symbol}&productType=USDT-FUTURES&orderId=${orderId}`);
            const fillPrice = parseFloat(detail?.priceAvg || detail?.fillPrice || '0');
            if (fillPrice > 0) {
              db.prepare('UPDATE trades SET entry_price = ? WHERE trade_id = ?').run(fillPrice, tradeId);
              console.log(`[Momentum] Entry price: ${tradeId} @ $${fillPrice}`);
            }
          } catch (e) { console.warn(`[Momentum] Fill price fetch failed for ${tradeId}:`, e.message); }
        }, 3000);
      }

      return true;
    } catch (err) {
      console.error(`[Momentum] ${symbol} trade failed:`, err.message);
      return false;
    } finally {
      tradingLock.release();
    }
  }

  return { scanMarketOpportunities, reviewPendingOrders, discoverNewCoins, runMomentumPipeline };
}
