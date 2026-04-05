/**
 * Researcher Agent: momentum-based analysis for new/trending coins.
 * Optimized for new listings — NOT traditional TA.
 * 4 dimensions: Volume Momentum, Price Action (ORB), Market Context, Narrative Heat.
 */

export function createResearcher({ db, config, bitgetClient, agentRunner, indicators, dataSources, log }) {
  const _log = log || { info: console.log, warn: console.warn, error: console.error };
  const { bitgetPublic } = bitgetClient;
  const { runAgent } = agentRunner;
  const { parseCandles } = indicators;
  const { fetchNews } = dataSources;
  const MOMENTUM = config.MOMENTUM;

  function buildResearchPrompt() {
    return `You are RIFI's New Coin Momentum Analyst. You evaluate TRENDING and NEWLY LISTED coins for short-term momentum trades. This is NOT traditional crypto analysis — new coins have little history, so forget RSI/MACD/Bollinger for decision-making.

Your workflow:
1. Call get_volume_profile to see hourly volume pattern and detect volume spikes
2. Call get_price_action to see recent candles, opening range, and price momentum
3. Call get_market_context for funding rate, OI, and broader signals
4. Call get_narrative for news/sector heat

SCORING FRAMEWORK (4 dimensions, score each 0-100):

1. Volume Momentum (30%):
   - Current hour volume vs 6h average: >3x = STRONG (80+), >2x = GOOD (65+), <1x = WEAK (<40)
   - Volume trending UP over last 3-4 hours = bullish momentum
   - Volume trending DOWN = momentum fading, be cautious
   - 24h total volume > $10M = excellent liquidity, $3-10M = OK, <$1M = dangerous

2. Price Action & ORB (30%):
   - Opening Range Breakout: if price broke above recent 4h high WITH volume → strong long signal
   - If price broke below recent 4h low WITH volume → strong short signal
   - Price making higher highs + higher lows in last few candles = uptrend momentum
   - Price making lower highs + lower lows = downtrend momentum
   - Large green candle (>3% move) with high volume = impulse buy signal
   - Large red candle (>3% drop) with high volume = impulse sell / short signal
   - Consolidation after pump = potential continuation or reversal, watch volume for confirmation

3. Market Context (20%):
   - Funding rate > 0.05% = longs overcrowded, lean short or avoid
   - Funding rate < -0.03% = shorts overcrowded, lean long (short squeeze potential)
   - Funding rate normal (-0.01% to 0.03%) = neutral, follow price action
   - OI increasing + price up = new money entering longs, bullish
   - OI increasing + price down = new money entering shorts, bearish
   - OI decreasing = positions closing, momentum weakening

4. Narrative Heat (20%):
   - Hot sector (AI, meme, RWA, gaming, L2) = bonus 10-20 points
   - Recent news mentions = active narrative, add points
   - No news = neutral (50), NOT a penalty — many new coins have no coverage yet
   - Negative news (hack, rug, scam alert) = major red flag, score 10-20

DECISION RULES:
- total_score >= 60 AND clear momentum direction → verdict: "TRADE"
- total_score >= 45 AND some signals but mixed → verdict: "WATCH"
- total_score < 45 OR major red flags → verdict: "SKIP"
- IMPORTANT: Be PROACTIVE. If volume is spiking and price is moving with conviction, TRADE. Don't over-think — momentum coins reward speed, not perfection.

For TRADE verdict, you MUST provide:
- direction: "long" if upward momentum, "short" if downward momentum
- entry_zone: tight range around current price (we use market orders)
- stop_loss: 1.5-2% from entry (15-20% risk at 10x leverage)
- take_profit: 2.5-4% from entry (TP:SL >= 1.5:1)

Output ONLY this JSON:
{
  "symbol": "XXXUSDT",
  "total_score": <0-100>,
  "scores": {
    "volume_momentum": <0-100>,
    "price_action": <0-100>,
    "market_context": <0-100>,
    "narrative": <0-100>
  },
  "verdict": "TRADE" | "WATCH" | "SKIP",
  "direction": "long" | "short" | null,
  "entry_zone": { "low": <price>, "high": <price> } | null,
  "stop_loss": <price> | null,
  "take_profit": <price> | null,
  "reasoning": "<中文2-3句，简洁说明动量判断依据，包含具体volume和价格数据>",
  "key_risks": ["<风险1>", "<风险2>"]
}`;
  }

  function buildResearchTools(symbol) {
    return [
      {
        type: 'function',
        function: {
          name: 'get_volume_profile',
          description: `Get hourly volume profile for ${symbol}: last 12 hours of volume data to detect spikes and trends`,
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_price_action',
          description: `Get recent price action for ${symbol}: last 12-24 1H candles, 4H range, current price vs high/low, candle patterns`,
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_market_context',
          description: `Get market context for ${symbol}: funding rate, open interest, 24h change, ticker data`,
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_narrative',
          description: `Search for news and narrative heat about ${symbol}: sector, mentions, sentiment`,
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
    ];
  }

  function buildResearchExecutors(symbol, candidateData) {
    const baseSymbol = symbol.replace('USDT', '');

    return {
      get_volume_profile: async () => {
        try {
          const candles = await bitgetPublic(
            `/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=1H&limit=12`
          );
          if (!candles?.length) return JSON.stringify({ error: 'No candle data' });

          // candles: [ts, open, high, low, close, vol, quoteVol] — newest first from Bitget
          const hourly = candles.map(c => ({
            time: new Date(parseInt(c[0])).toISOString().slice(11, 16),
            volume_usdt: parseFloat(c[6] || c[5] || 0),
            close: parseFloat(c[4]),
            change_pct: ((parseFloat(c[4]) - parseFloat(c[1])) / parseFloat(c[1]) * 100).toFixed(2) + '%',
          }));

          const volumes = hourly.map(h => h.volume_usdt);
          const avg6h = volumes.slice(0, 6).reduce((s, v) => s + v, 0) / Math.min(6, volumes.length);
          const currentVol = volumes[0] || 0;
          const volumeRatio = avg6h > 0 ? parseFloat((currentVol / avg6h).toFixed(2)) : 1.0;

          // Volume trend: compare first half vs second half
          const recentAvg = volumes.slice(0, 4).reduce((s, v) => s + v, 0) / 4;
          const olderAvg = volumes.slice(4, 8).reduce((s, v) => s + v, 0) / Math.min(4, volumes.slice(4, 8).length || 1);
          const volumeTrend = olderAvg > 0 ? (recentAvg > olderAvg * 1.3 ? 'INCREASING' : recentAvg < olderAvg * 0.7 ? 'DECREASING' : 'STABLE') : 'UNKNOWN';

          return JSON.stringify({
            symbol,
            hourly_candles: hourly,
            current_hour_volume: currentVol,
            avg_6h_volume: avg6h,
            volume_spike_ratio: volumeRatio,
            volume_trend: volumeTrend,
            volume_24h: candidateData.volume || 0,
          });
        } catch (e) {
          return JSON.stringify({ error: e.message });
        }
      },

      get_price_action: async () => {
        try {
          const [candles1h, candles4h] = await Promise.all([
            bitgetPublic(`/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=1H&limit=24`),
            bitgetPublic(`/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=4H&limit=6`),
          ]);

          // 1H candles for price structure
          const h1 = (candles1h || []).map(c => ({
            open: parseFloat(c[1]), high: parseFloat(c[2]),
            low: parseFloat(c[3]), close: parseFloat(c[4]),
          }));

          // Opening Range from last 4H candle
          const h4 = (candles4h || []).map(c => ({
            open: parseFloat(c[1]), high: parseFloat(c[2]),
            low: parseFloat(c[3]), close: parseFloat(c[4]),
          }));
          const openingRange = h4[0] ? { high: h4[0].high, low: h4[0].low, open: h4[0].open, close: h4[0].close } : null;

          // Current price vs opening range
          const currentPrice = h1[0]?.close || candidateData.price || 0;
          let orbSignal = 'INSIDE_RANGE';
          if (openingRange) {
            if (currentPrice > openingRange.high) orbSignal = 'BREAKOUT_UP';
            else if (currentPrice < openingRange.low) orbSignal = 'BREAKOUT_DOWN';
          }

          // Price momentum: higher highs check on last 4 candles
          const recent4 = h1.slice(0, 4).reverse(); // oldest to newest
          let higherHighs = 0, lowerLows = 0;
          for (let i = 1; i < recent4.length; i++) {
            if (recent4[i].high > recent4[i - 1].high) higherHighs++;
            if (recent4[i].low < recent4[i - 1].low) lowerLows++;
          }
          const priceTrend = higherHighs >= 2 ? 'UPTREND' : lowerLows >= 2 ? 'DOWNTREND' : 'CHOPPY';

          // Largest recent candle move
          const biggestMove = h1.slice(0, 6).reduce((max, c) => {
            const move = Math.abs(c.close - c.open) / c.open * 100;
            return move > max.pct ? { pct: move, direction: c.close > c.open ? 'UP' : 'DOWN' } : max;
          }, { pct: 0, direction: 'FLAT' });

          return JSON.stringify({
            symbol,
            current_price: currentPrice,
            opening_range_4h: openingRange,
            orb_signal: orbSignal,
            price_trend_4candles: priceTrend,
            higher_highs: higherHighs,
            lower_lows: lowerLows,
            biggest_recent_candle: { pct: biggestMove.pct.toFixed(2) + '%', direction: biggestMove.direction },
            change_24h: candidateData.change24h,
            high_24h: candidateData.high24h,
            low_24h: candidateData.low24h,
          });
        } catch (e) {
          return JSON.stringify({ error: e.message });
        }
      },

      get_market_context: async () => {
        try {
          const [tickerData, oiData] = await Promise.all([
            bitgetPublic(`/api/v2/mix/market/ticker?symbol=${symbol}&productType=USDT-FUTURES`).catch(() => null),
            bitgetPublic(`/api/v2/mix/market/open-interest?symbol=${symbol}&productType=USDT-FUTURES`).catch(() => null),
          ]);
          const ticker = Array.isArray(tickerData) ? tickerData[0] : tickerData;
          const oi = Array.isArray(oiData) ? oiData[0] : oiData;

          const fundingRate = parseFloat(ticker?.fundingRate || '0');
          let fundingSignal = 'NEUTRAL';
          if (fundingRate > 0.0005) fundingSignal = 'LONGS_CROWDED';
          else if (fundingRate < -0.0003) fundingSignal = 'SHORTS_CROWDED';

          return JSON.stringify({
            symbol,
            price: ticker?.lastPr,
            funding_rate: fundingRate,
            funding_rate_pct: (fundingRate * 100).toFixed(4) + '%',
            funding_signal: fundingSignal,
            open_interest: oi?.openInterest || oi?.amount,
            open_interest_usd: oi?.openInterestUsd || oi?.value,
            volume_24h: ticker?.usdtVolume,
            change_24h: ticker?.change24h,
          });
        } catch (e) {
          return JSON.stringify({ error: e.message });
        }
      },

      get_narrative: async () => {
        try {
          const name = baseSymbol.toUpperCase();
          const news = await fetchNews(15);
          const relevant = news.filter(n => {
            const text = ((n.title || '') + ' ' + (n.summary || '')).toLowerCase();
            return text.includes(baseSymbol.toLowerCase()) || text.includes(name.toLowerCase());
          });

          // Try to identify sector from symbol name or any news
          const sectorKeywords = {
            AI: ['ai', 'artificial', 'machine learning', 'gpt', 'agent'],
            MEME: ['meme', 'doge', 'pepe', 'shib', 'bonk', 'floki'],
            RWA: ['rwa', 'real world', 'tokenized', 'asset'],
            GAMING: ['game', 'gaming', 'play', 'metaverse', 'nft'],
            DEFI: ['defi', 'dex', 'swap', 'yield', 'lending', 'staking'],
            L2: ['layer 2', 'l2', 'rollup', 'scaling', 'zk'],
          };

          let detectedSector = 'UNKNOWN';
          const allText = relevant.map(n => (n.title || '') + ' ' + (n.summary || '')).join(' ').toLowerCase();
          for (const [sector, keywords] of Object.entries(sectorKeywords)) {
            if (keywords.some(k => allText.includes(k) || baseSymbol.toLowerCase().includes(k))) {
              detectedSector = sector;
              break;
            }
          }

          return JSON.stringify({
            symbol: name,
            news_found: relevant.length,
            sector: detectedSector,
            note: relevant.length === 0 ? `No specific news for ${name}. Score narrative as 50 (neutral) — no news is normal for new coins.` : undefined,
            articles: relevant.slice(0, 5).map(n => ({
              title: (n.title || '').slice(0, 120),
              score: n.score || 0,
              signal: n.signal || 'neutral',
            })),
            general_market: news.slice(0, 3).map(n => ({
              title: (n.title || '').slice(0, 80),
              signal: n.signal || 'neutral',
            })),
          });
        } catch (e) {
          _log.warn('narrative_fetch_failed', { module: 'researcher', symbol: baseSymbol, error: e.message });
          return JSON.stringify({ note: 'News unavailable, score narrative as 50' });
        }
      },
    };
  }

  async function researchCoin(symbol, candidateData) {
    const traceId = `research_${symbol}_${Date.now()}`;
    const systemPrompt = buildResearchPrompt();
    const tools = buildResearchTools(symbol);
    const executors = buildResearchExecutors(symbol, candidateData);

    try {
      const result = await runAgent('researcher', systemPrompt, tools, executors,
        `Evaluate ${symbol} for a momentum trade. Fetch volume profile, price action, market context, and narrative. Be decisive — if momentum is there, recommend TRADE.`,
        { trace_id: traceId, max_tokens: 1000, timeout: 60000 }
      );

      const jsonStr = result.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(jsonStr);

      // Recalculate total_score from dimension scores (LLM math can be wrong)
      if (parsed.scores) {
        const s = parsed.scores;
        parsed.total_score = Math.round(
          0.3 * (s.volume_momentum || 0) + 0.3 * (s.price_action || 0) +
          0.2 * (s.market_context || 0) + 0.2 * (s.narrative || 0)
        );
      }

      // Persist research to decisions
      try {
        db.insertDecision.run(new Date().toISOString(), 'researcher', 'research', 'evaluate',
          JSON.stringify({ symbol, candidateData }), JSON.stringify(parsed),
          `Research: ${symbol}`, parsed.reasoning || '', '', parsed.total_score || 0, null);
      } catch (e) { _log.warn('caught_error', { module: 'researcher', error: e.message }); }

      _log.info('research_result', { module: 'researcher', symbol, score: parsed.total_score, verdict: parsed.verdict, direction: parsed.direction, reasoning: parsed.reasoning?.slice(0, 100) });
      return parsed;
    } catch (err) {
      _log.error('research_failed', { module: 'researcher', symbol, error: err.message });
      return null;
    }
  }

  return { researchCoin };
}
