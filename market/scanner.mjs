/**
 * Market scanner: opportunity detection + pending order review + momentum coin discovery & trading.
 */

import { calcRSI, calcBollinger } from './indicators.mjs';

export function createScanner({ db, config, bitgetClient, agentRunner, indicators, tradingLock, researcher, compound, log, metrics }) {
  const { bitgetPublic, bitgetRequest, roundPrice } = bitgetClient;
  const { runAgent } = agentRunner;
  const { insertDecision, insertTrade, insertCandidate, updateCandidateResearch, markCandidateTraded } = db;
  const MOMENTUM = config.MOMENTUM;
  const _log = log || { info: console.log, warn: console.warn, error: console.error };

  // Cache known symbols to detect new listings
  let _knownSymbols = new Set();
  let _bootCycles = 0;

  /**
   * Scan market for opportunities — returns data for analyst, does NOT place trades.
   */
  async function scanMarketOpportunities() {
    if (!config.BITGET_API_KEY) return [];
    _log.info('scanning', { module: 'scanner' });

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
          const scanTF = config.MOMENTUM?.timeframe || '1H';
          const candles = await bitgetPublic(`/api/v2/mix/market/candles?symbol=${c.symbol}&productType=USDT-FUTURES&granularity=${scanTF}&limit=50`);
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

      _log.info('scan_result', { module: 'scanner', opportunities: opportunities.length, candidates: candidates.length });
      return opportunities;
    } catch (err) {
      _log.error('scanner_error', { module: 'scanner', error: err.message });
      return [];
    }
  }

  /**
   * Review and clean up pending limit orders.
   * Still needed: executor now places limit orders for confidence 60-80.
   */
  async function reviewPendingOrders() {
    if (!config.BITGET_API_KEY) return;
    _log.info('reviewing_pending_orders', { module: 'pending_review' });

    try {
      const pendingData = await bitgetRequest('GET', '/api/v2/mix/order/orders-pending?productType=USDT-FUTURES');
      const allPending = pendingData?.entrustedList || (Array.isArray(pendingData) ? pendingData : []);

      const limitOrders = allPending.filter(o => o.orderType !== 'plan');
      if (!limitOrders.length) {
        _log.info('no_pending_orders', { module: 'pending_review' });
        return;
      }
      _log.info('pending_orders_found', { module: 'pending_review', count: limitOrders.length });

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
        _log.info('llm_review_start', { module: 'pending_review', surviving: toKeep.length });
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
          _log.info('llm_review_result', { module: 'pending_review', cancel_count: llmCancelIds.size, reason: parsed.reason });
        } catch (e) {
          _log.warn('llm_review_failed', { module: 'pending_review', error: e.message });
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
          _log.info('order_cancelled', { module: 'pending_review', symbol: order.symbol, side: order.side, price: order.price, reason });

          insertDecision.run(
            new Date().toISOString(), 'scanner', 'cancel_pending', 'cancel-order',
            JSON.stringify({ symbol: order.symbol, side: order.side, price: order.price, orderId: order.orderId }),
            JSON.stringify({ reason }), `Pending order cancelled: ${reason}`, '', '', 0, null
          );

          await new Promise(r => setTimeout(r, 100));
        } catch (e) {
          _log.error('cancel_failed', { module: 'pending_review', orderId: order.orderId, error: e.message });
        }
      }

      _log.info('pending_review_done', { module: 'pending_review', cancelled: allToCancel.length, kept: limitOrders.length - allToCancel.length });
    } catch (err) {
      _log.error('pending_review_error', { module: 'pending_review', error: err.message });
    }
  }

  // ──────── Momentum: New Coin Discovery & Research Trading ────────

  /**
   * Discover new/trending coins on Bitget futures.
   * Returns array of candidate objects for research.
   */
  async function discoverNewCoins() {
    if (!MOMENTUM?.enabled || !config.BITGET_API_KEY) return [];
    _log.info('scanning_coins', { module: 'discovery' });

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
        if (newListings.length > 0) _log.info('new_listings_detected', { module: 'discovery', count: newListings.length, symbols: newListings.map(n => n.symbol) });
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

      _log.info('discovery_result', { module: 'discovery', new_listings: newListings.length, trending: trending.length, total: unique.length });
      return unique;
    } catch (err) {
      _log.error('discovery_error', { module: 'discovery', error: err.message });
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
  async function runMomentumPipeline(cycleId) {
    if (!MOMENTUM?.enabled || !researcher) return;

    // Compound param overrides (AI-decided parameters)
    const _overrides = compound?.getParamOverrides?.() || {};

    // Load active compound strategies that target momentum symbols
    let activeStrategies = [];
    try {
      activeStrategies = db.prepare("SELECT * FROM compound_strategies WHERE status = 'active'")
        .all().map(s => ({ ...s, symbols: JSON.parse(s.symbols || '[]'), risk_params: JSON.parse(s.risk_params_json || '{}'), sizing: JSON.parse(s.sizing_json || '{}') }));
    } catch {}

    // 1. Discover
    const candidates = await discoverNewCoins();
    if (!candidates.length) return;

    // 2. Check how many momentum trades are already open
    const openMomentum = db.prepare(
      "SELECT COUNT(*) as cnt FROM trades WHERE status = 'open' AND trade_id LIKE 'res_%'"
    ).get();
    const maxOpen = _overrides.max_open || MOMENTUM.max_open;
    if (openMomentum.cnt >= maxOpen) {
      _log.info('momentum_slots_full', { module: 'momentum', open: openMomentum.cnt, max: maxOpen });
      return;
    }

    // 3. Check 24h momentum losses (realized + unrealized)
    const losses24h = db.prepare(
      "SELECT COALESCE(SUM(ABS(pnl)), 0) as total_loss FROM trades WHERE status = 'closed' AND pnl < 0 AND trade_id LIKE 'res_%' AND closed_at > datetime('now', '-1 day')"
    ).get();
    // Include unrealized losses from open momentum positions (compute from entry vs current price)
    let floatingLoss = 0;
    try {
      const openTrades = db.prepare(
        "SELECT pair, side, entry_price, amount, leverage FROM trades WHERE status = 'open' AND trade_id LIKE 'res_%'"
      ).all();
      for (const t of openTrades) {
        const dir = t.side === 'buy' ? 1 : -1;
        const entry = parseFloat(t.entry_price || 0);
        const amt = parseFloat(t.amount || 0);
        if (!entry || !amt) continue;
        // Get current price from Bitget
        try {
          const ticker = await bitgetRequest('GET', `/api/v2/mix/market/ticker?symbol=${t.pair}&productType=USDT-FUTURES`);
          const cur = parseFloat((Array.isArray(ticker) ? ticker[0] : ticker)?.lastPr || '0');
          if (cur > 0) {
            const pnl = dir * (cur - entry) * amt;
            if (pnl < 0) floatingLoss += Math.abs(pnl);
          }
        } catch {}
      }
    } catch (e) { _log.warn('floating_loss_calc_failed', { module: 'momentum', error: e.message }); }
    const totalLoss24h = losses24h.total_loss + floatingLoss;
    const maxLoss = _overrides.max_daily_loss || MOMENTUM.max_daily_loss;
    if (totalLoss24h >= maxLoss) {
      _log.info('momentum_daily_loss_limit', { module: 'momentum', realized: losses24h.total_loss, floating: openMomentumPnl?.float_loss || 0, total: totalLoss24h, max_loss: maxLoss });
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
        // Check if a compound strategy targets this symbol — use its risk params
        const matchingStrat = activeStrategies.find(s =>
          s.symbols.includes(candidate.symbol) && (s.direction === report.direction || s.direction === 'both')
        );
        const minScore = _overrides.min_score || MOMENTUM.min_score;
        if (report.verdict === 'TRADE' && report.total_score >= minScore && report.direction) {
          const traded = await executeMomentumTrade(candidate.symbol, report, matchingStrat);
          if (traded) {
            slotsAvailable--;
            if (candidateRow) markCandidateTraded.run(candidateRow.id);
          }
        }
      } catch (err) {
        _log.error('momentum_research_error', { module: 'momentum', symbol: candidate.symbol, error: err.message });
      }
    }
  }

  /**
   * Execute a momentum trade based on research report.
   */
  async function executeMomentumTrade(symbol, report, matchingStrategy = null) {
    if (!tradingLock || !tradingLock.acquire()) {
      _log.info('trading_lock_active', { module: 'momentum' });
      return false;
    }

    try {
      const isBuy = report.direction === 'long';
      const side = isBuy ? 'buy' : 'sell';
      const holdSide = isBuy ? 'long' : 'short';

      // Apply compound param overrides (AI-decided parameters)
      // Strategy-specific params take priority over global overrides
      const overrides = compound?.getParamOverrides?.() || {};
      const stratSizing = matchingStrategy?.sizing || {};
      const stratRisk = matchingStrategy?.risk_params || {};
      const leverage = String(stratSizing.leverage || overrides.leverage || MOMENTUM.leverage);

      // Check balance
      const accounts = await bitgetRequest('GET', '/api/v2/mix/account/accounts?productType=USDT-FUTURES');
      const usdtBal = accounts?.find(a => a.marginCoin === 'USDT');
      const available = parseFloat(usdtBal?.crossedMaxAvailable || usdtBal?.available || '0');
      const marginPerTrade = stratSizing.margin_usdt || overrides.margin_per_trade || MOMENTUM.margin_per_trade;
      if (available < marginPerTrade) {
        _log.info('insufficient_margin', { module: 'momentum', available, required: marginPerTrade });
        return false;
      }

      // Check no duplicate position
      try {
        const posData = await bitgetRequest('GET', '/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT');
        const positions = Array.isArray(posData) ? posData : (posData?.list || []);
        if (positions.find(p => p.symbol === symbol && p.holdSide === holdSide && parseFloat(p.total || '0') > 0)) {
          _log.info('duplicate_position', { module: 'momentum', symbol, side: holdSide });
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
        _log.error('no_price', { module: 'momentum', symbol });
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

      // TP/SL — strategy params → compound overrides → defaults
      const tpPct = stratRisk.tp_pct || overrides.tp_pct || 0.03;
      const slPct = stratRisk.sl_pct || overrides.sl_pct || 0.015;
      const tpRaw = isBuy ? currentPrice * (1 + tpPct) : currentPrice * (1 - tpPct);
      const slRaw = isBuy ? currentPrice * (1 - slPct) : currentPrice * (1 + slPct);
      const tp = await roundPrice(symbol, tpRaw);
      const sl = await roundPrice(symbol, slRaw);
      orderParams.presetStopSurplusPrice = String(tp);
      orderParams.presetStopLossPrice = String(sl);

      // Place order
      const order = await bitgetRequest('POST', '/api/v2/mix/order/place-order', orderParams);
      const orderId = order?.orderId;

      _log.info('momentum_trade', { module: 'momentum', side: holdSide, size, symbol, leverage, price: currentPrice, score: report.total_score, sl, tp, orderId, strategy: matchingStrategy?.strategy_id || null });

      // Record trade
      const tradeId = `res_${orderId || Date.now()}`;
      insertTrade.run(tradeId, 'bitget', symbol, side, currentPrice, parseFloat(size), 0,
        parseInt(leverage), 'open', orderId || '', JSON.stringify(report),
        `Momentum: score ${report.total_score}${matchingStrategy ? ' strat:' + matchingStrategy.strategy_id : ''}, ${report.reasoning?.slice(0, 100)}`, new Date().toISOString());
      if (matchingStrategy) {
        try { db.prepare('UPDATE trades SET strategy_id = ? WHERE trade_id = ?').run(matchingStrategy.strategy_id, tradeId); } catch {}
      }

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
              _log.info('entry_price_updated', { module: 'momentum', tradeId, fillPrice });
            }
          } catch (e) { _log.warn('fill_price_fetch_failed', { module: 'momentum', tradeId, error: e.message }); }
        }, 3000);
      }

      return true;
    } catch (err) {
      _log.error('momentum_trade_failed', { module: 'momentum', symbol, error: err.message });
      return false;
    } finally {
      tradingLock.release();
    }
  }

  return { scanMarketOpportunities, reviewPendingOrders, discoverNewCoins, runMomentumPipeline };
}
