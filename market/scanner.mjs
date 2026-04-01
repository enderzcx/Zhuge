/**
 * Market scanner: opportunity detection + technical trading via LLM.
 */

import { calcRSI, calcBollinger } from './indicators.mjs';

export function createScanner({ db, config, bitgetClient, agentRunner, indicators, tradingLock }) {
  const { bitgetPublic, bitgetRequest } = bitgetClient;
  const { runAgent } = agentRunner;
  const { insertTrade, insertDecision } = db;

  async function scanMarketOpportunities() {
    if (!config.BITGET_API_KEY) return;
    console.log('[Scanner] Scanning futures market...');

    try {
      // 1. Get all futures tickers
      const tickers = await bitgetPublic('/api/v2/mix/market/tickers?productType=USDT-FUTURES');
      if (!tickers?.length) return;

      // 2. Filter: volume > $5M, meaningful move
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

      // 3. For top 10 candidates, fetch 1h candles and compute indicators
      const opportunities = [];
      for (const c of candidates.slice(0, 10)) {
        try {
          const candles = await bitgetPublic(`/api/v2/mix/market/candles?symbol=${c.symbol}&productType=USDT-FUTURES&granularity=1H&limit=50`);
          if (!candles?.length) continue;

          // Parse candles: [ts, open, high, low, close, vol, quoteVol]
          const closes = candles.map(k => parseFloat(k[4])).reverse(); // oldest first
          const highs = candles.map(k => parseFloat(k[2])).reverse();
          const lows = candles.map(k => parseFloat(k[3])).reverse();

          // RSI (14)
          const rsi = calcRSI(closes, 14);
          // MA20, MA50
          const ma20 = closes.length >= 20 ? closes.slice(-20).reduce((s, v) => s + v, 0) / 20 : null;
          const ma50 = closes.length >= 50 ? closes.slice(-50).reduce((s, v) => s + v, 0) / 50 : null;
          // Bollinger Bands (20, 2)
          const bb = calcBollinger(closes, 20);
          // Support & Resistance (recent swing lows/highs)
          const support = Math.min(...lows.slice(-20));
          const resistance = Math.max(...highs.slice(-20));

          opportunities.push({
            ...c,
            rsi,
            ma20,
            ma50,
            bb,
            support,
            resistance,
            signal: rsi < 30 ? 'oversold' : rsi > 70 ? 'overbought' : 'neutral',
            trend: ma20 && ma50 ? (ma20 > ma50 ? 'bullish' : 'bearish') : 'unknown',
          });
        } catch {}
      }

      // 4. Check margin + pending orders before trading
      let availableMargin = 0;
      let totalEquity = 0;
      try {
        const accts = await bitgetRequest('GET', '/api/v2/mix/account/accounts?productType=USDT-FUTURES');
        const usdt = (accts || []).find(a => a.marginCoin === 'USDT');
        availableMargin = parseFloat(usdt?.crossedMaxAvailable || usdt?.available || '0');
        totalEquity = parseFloat(usdt?.accountEquity || '0');
      } catch {}

      // If margin locked by pending orders, cancel them to free up for potentially better trades
      if (availableMargin < 2.0 && totalEquity >= 2.0) {
        console.log(`[Scanner] Margin locked ($${availableMargin.toFixed(2)} avail / $${totalEquity.toFixed(2)} equity). Checking pending orders...`);
        try {
          const pendingData = await bitgetRequest('GET', '/api/v2/mix/order/orders-pending?productType=USDT-FUTURES');
          const pendingOrders = pendingData?.entrustedList || (Array.isArray(pendingData) ? pendingData : []);
          if (pendingOrders.length > 0) {
            // Only cancel limit/market orders, not TP/SL plan orders
            const cancellable = pendingOrders.filter(o => o.orderType === 'limit' || o.orderType === 'market');
            console.log(`[Scanner] Found ${pendingOrders.length} pending order(s), ${cancellable.length} cancellable (excluding TP/SL).`);
            for (const order of cancellable) {
              try {
                await bitgetRequest('POST', '/api/v2/mix/order/cancel-order', {
                  symbol: order.symbol, productType: 'USDT-FUTURES', orderId: order.orderId,
                });
                console.log(`[Scanner] Cancelled ${order.symbol} ${order.side} @ ${order.price} (orderId: ${order.orderId})`);
              } catch (e) { console.error(`[Scanner] Cancel failed:`, e.message); }
            }
            // Re-check available margin after cancellation
            await new Promise(r => setTimeout(r, 1000));
            const accts2 = await bitgetRequest('GET', '/api/v2/mix/account/accounts?productType=USDT-FUTURES');
            const usdt2 = (accts2 || []).find(a => a.marginCoin === 'USDT');
            availableMargin = parseFloat(usdt2?.crossedMaxAvailable || usdt2?.available || '0');
            console.log(`[Scanner] After cancel: available margin $${availableMargin.toFixed(2)}`);
          }
        } catch (e) { console.error('[Scanner] Pending order check failed:', e.message); }
      }

      // Only call LLM if at least one opportunity has extreme RSI (saves ~300K tokens/day)
      const extremeSetups = opportunities.filter(o => o.rsi < 25 || o.rsi > 75);

      if (availableMargin < 2.0) {
        console.log(`[Scanner] Skip trading: available margin $${availableMargin.toFixed(2)} < $2.00`);
      } else if (extremeSetups.length > 0) {
        console.log(`[Scanner] ${extremeSetups.length} extreme RSI setups found, calling LLM...`);
        await runTechnicalTrading(opportunities); // pass all for context, but LLM knows to focus on extremes
      } else {
        console.log(`[Scanner] No extreme RSI setups (range: ${Math.min(...opportunities.map(o => o.rsi)).toFixed(0)}-${Math.max(...opportunities.map(o => o.rsi)).toFixed(0)}), skip LLM`);
      }

      console.log(`[Scanner] Found ${opportunities.length} opportunities from ${candidates.length} candidates`);
    } catch (err) {
      console.error('[Scanner] Error:', err.message);
    }
  }

  async function runTechnicalTrading(opportunities) {
    if (!tradingLock.acquire()) { console.log('[TechTrading] Trading lock active, skip'); return; }
    try { await _runTechnicalTradingInner(opportunities); } finally { tradingLock.release(); }
  }

  async function _runTechnicalTradingInner(opportunities) {
    const traceId = `tech_${Date.now()}`;
    const prompt = `You are RIFI's Technical Trading Agent. Analyze these opportunities and decide which ones to trade.

Available balance: ~$2.7 USDT in Bitget futures. Use 10x leverage. Pick only 1 best setup and go all-in with full balance.

Opportunities (sorted by 24h move):
${JSON.stringify(opportunities, null, 2)}

Rules:
- Pick ONLY 1 best setup — go all-in, you have very limited capital
- Prefer: RSI oversold (<30) for longs, RSI overbought (>70) for shorts
- Use limit orders at support/resistance levels, NOT market orders
- Set tight stop-loss (2-3% from entry for 10x = 20-30% account risk)
- Position size: use 2.0-2.5 USDT margin (nearly full balance). Bitget min order is usually ~5 USDT notional, so with 10x leverage 2.5 USDT margin = $25 notional.
- Prefer coins with high volume and extreme funding rates (arb potential)
- If nothing looks good, respond with empty trades array

Respond with JSON:
{
  "analysis": "<Chinese 2-3 sentence market overview>",
  "trades": [
    {
      "symbol": "XXXUSDT",
      "side": "buy|sell",
      "size": "<min contract size>",
      "orderType": "limit",
      "price": "<entry price at support/resistance>",
      "stopLoss": "<price>",
      "takeProfit": "<price>",
      "reason": "<Chinese one-line reason>"
    }
  ]
}`;

    try {
      const result = await runAgent('executor', prompt, [], {}, 'Execute technical analysis trades', {
        trace_id: traceId, max_tokens: 800, timeout: 30000, model: config.AGENT_MODELS?.analyst,
      });

      let parsed;
      try {
        const jsonStr = result.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        parsed = JSON.parse(jsonStr);
      } catch {
        console.warn('[TechTrading] Parse failed:', result.content.slice(0, 100));
        return;
      }

      console.log(`[TechTrading] ${parsed.trades?.length || 0} trades proposed: ${parsed.analysis?.slice(0, 80)}`);

      // Execute each trade
      for (const trade of (parsed.trades || [])) {
        try {
          // Set leverage
          const holdSide = trade.side === 'buy' ? 'long' : 'short';
          await bitgetRequest('POST', '/api/v2/mix/account/set-leverage', {
            symbol: trade.symbol, productType: 'USDT-FUTURES', marginCoin: 'USDT',
            leverage: '10', holdSide,
          }).catch(() => {});

          // Validate LLM output
          const entryPrice = parseFloat(trade.price);
          if (!entryPrice || isNaN(entryPrice) || entryPrice <= 0) {
            console.warn(`[TechTrading] Invalid price for ${trade.symbol}: ${trade.price}, skip`);
            continue;
          }
          if (!trade.side || !['buy', 'sell'].includes(trade.side)) {
            console.warn(`[TechTrading] Invalid side for ${trade.symbol}: ${trade.side}, skip`);
            continue;
          }

          // Calculate proper size in contracts
          // Bitget size = number of contracts. Notional = size * price. Margin = notional / leverage.
          // We want to use ~$2.5 margin with 10x leverage = $25 notional. size = 25 / price.
          const targetNotional = 25; // $2.5 margin * 10x leverage
          let contractSize = Math.max(1, Math.round(targetNotional / entryPrice));
          // For high-price assets (BTC, ETH), size is in base units (e.g. 0.001 BTC)
          if (entryPrice > 100) contractSize = Math.max(parseFloat(trade.size) || 1, +(targetNotional / entryPrice).toFixed(4));
          const finalSize = String(contractSize);
          console.log(`[TechTrading] ${trade.symbol} size calc: price=${entryPrice} targetNotional=${targetNotional} → size=${finalSize}`);

          // Place limit order with order-level TP/SL (works before fill, unlike position-level)
          const orderParams = {
            symbol: trade.symbol, productType: 'USDT-FUTURES', marginMode: 'crossed',
            marginCoin: 'USDT', side: trade.side, tradeSide: 'open',
            orderType: trade.orderType || 'limit', size: finalSize,
            ...(trade.price ? { price: String(trade.price) } : {}),
          };
          // Attach TP/SL at order level so they activate when the order fills
          if (trade.takeProfit) orderParams.presetStopSurplusPrice = String(trade.takeProfit);
          if (trade.stopLoss) orderParams.presetStopLossPrice = String(trade.stopLoss);

          const order = await bitgetRequest('POST', '/api/v2/mix/order/place-order', orderParams);

          console.log(`[TechTrading] ${holdSide.toUpperCase()} ${trade.symbol} @ ${trade.price || 'market'} | SL:${trade.stopLoss || '-'} TP:${trade.takeProfit || '-'} | orderId: ${order?.orderId}`);

          // Record to both trades and decisions tables (so Risk Agent sees scanner trades)
          const tradeId = `tech_${order?.orderId || Date.now()}`;
          try {
            insertTrade.run(tradeId, 'bitget', trade.symbol, trade.side, entryPrice, parseFloat(finalSize), 0,
              'open', order?.orderId || '', JSON.stringify({ scanner: true, rsi: trade.rsi, reason: trade.reason }),
              `Tech: ${trade.reason}`, new Date().toISOString());
          } catch {}
          insertDecision.run(new Date().toISOString(), 'executor', 'tech_trade', 'limit-order',
            JSON.stringify(trade), JSON.stringify(order), `Tech: ${trade.reason}`, '', '', 0, tradeId);

        } catch (err) {
          console.error(`[TechTrading] ${trade.symbol} failed:`, err.message);
        }
      }
    } catch (err) {
      console.error('[TechTrading] Agent error:', err.message);
    }
  }

  return { scanMarketOpportunities };
}
