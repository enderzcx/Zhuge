/**
 * Researcher Agent: deep-dive analysis on coin candidates before trading.
 * 5-dimension scoring: Market Traction, Technical Setup, Tokenomics, Narrative, Risk.
 */

export function createResearcher({ db, config, bitgetClient, agentRunner, indicators, dataSources }) {
  const { bitgetPublic } = bitgetClient;
  const { runAgent } = agentRunner;
  const { parseCandles, computeIndicators } = indicators;
  const { fetchNews } = dataSources;
  const MOMENTUM = config.MOMENTUM;

  function buildResearchPrompt() {
    return `You are RIFI's Coin Research Analyst. You receive data about a coin candidate and must evaluate it across 5 dimensions, then decide whether to trade.

Your workflow:
1. Call get_coin_market_data for real-time price, volume, funding rate, OI
2. Call get_coin_technicals for 1H/4H RSI, MACD, Bollinger, ATR, support/resistance
3. Call get_coin_info for market cap, circulating supply, FDV, description from CoinGecko
4. Call get_coin_news to search for recent news about this coin

SCORING FRAMEWORK (score each 0-100):

1. Market Traction (25%):
   - 24h volume > $5M = good, > $20M = excellent
   - Volume increasing vs yesterday = bullish
   - OI rising + price rising = bullish momentum
   - Funding rate extreme (>0.05% or <-0.03%) = crowded, risky

2. Technical Setup (25%):
   - RSI < 35 = oversold (long opportunity), RSI > 65 = overbought (short opportunity)
   - Price near Bollinger lower band = long, near upper = short
   - MACD crossing up = bullish, crossing down = bearish
   - ATR high = volatile = more profit potential but more risk

3. Tokenomics (20%):
   - Market cap / FDV ratio: > 0.5 = good (low unlock pressure), < 0.1 = red flag
   - Circulating supply / total supply: higher = better (less inflation risk)
   - If no CoinGecko data available, score 50 (neutral) and note data unavailable

4. Narrative/News (20%):
   - Positive news + high relevance = bullish
   - No news = neutral (50)
   - Negative news (hack, rug pull, regulatory) = bearish, score low

5. Risk Flags (10%):
   - Funding rate extreme = deduct points
   - Very new listing (< 24h) = extra volatile, deduct 10
   - Low liquidity (volume < $2M) = deduct 20
   - Score inversely: more risk = LOWER score

DECISION RULES:
- total_score >= 70 AND clear technical setup → verdict: "TRADE"
- total_score >= 55 AND mixed signals → verdict: "WATCH"
- total_score < 55 OR major risk flags → verdict: "SKIP"

For TRADE verdict, you MUST provide:
- direction: "long" if oversold/bullish, "short" if overbought/bearish
- entry_zone: current price range (tight, within 1% of current price since we use market orders)
- stop_loss: 2-3% from entry (20-30% risk at 10x leverage)
- take_profit: 3-5% from entry (SL:TP >= 1:1.5)

Output ONLY this JSON:
{
  "symbol": "XXXUSDT",
  "total_score": <0-100>,
  "scores": {
    "market_traction": <0-100>,
    "technical_setup": <0-100>,
    "tokenomics": <0-100>,
    "narrative": <0-100>,
    "risk_flags": <0-100>
  },
  "verdict": "TRADE" | "WATCH" | "SKIP",
  "direction": "long" | "short" | null,
  "entry_zone": { "low": <price>, "high": <price> } | null,
  "stop_loss": <price> | null,
  "take_profit": <price> | null,
  "reasoning": "<中文3-4句调研结论，包含具体数据>",
  "key_risks": ["<风险1>", "<风险2>"]
}`;
  }

  function buildResearchTools(symbol) {
    return [
      {
        type: 'function',
        function: {
          name: 'get_coin_market_data',
          description: `Get real-time market data for ${symbol}: price, 24h volume, funding rate, open interest`,
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_coin_technicals',
          description: `Get 1H and 4H technical indicators for ${symbol}: EMA, RSI, MACD, ATR, Bollinger, support/resistance`,
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_coin_info',
          description: `Get fundamental info for ${symbol} from CoinGecko: market cap, circulating supply, FDV, description`,
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_coin_news',
          description: `Search recent news about ${symbol} to assess narrative and sentiment`,
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
    ];
  }

  function buildResearchExecutors(symbol, candidateData) {
    const baseSymbol = symbol.replace('USDT', '').toLowerCase();

    return {
      get_coin_market_data: async () => {
        try {
          const [tickerData, oiData] = await Promise.all([
            bitgetPublic(`/api/v2/mix/market/ticker?symbol=${symbol}&productType=USDT-FUTURES`).catch(() => null),
            bitgetPublic(`/api/v2/mix/market/open-interest?symbol=${symbol}&productType=USDT-FUTURES`).catch(() => null),
          ]);
          const ticker = Array.isArray(tickerData) ? tickerData[0] : tickerData;
          const oi = Array.isArray(oiData) ? oiData[0] : oiData;
          return JSON.stringify({
            symbol,
            price: ticker?.lastPr,
            change24h: ticker?.change24h,
            volume24h: ticker?.usdtVolume,
            high24h: ticker?.high24h,
            low24h: ticker?.low24h,
            fundingRate: ticker?.fundingRate,
            openInterest: oi?.openInterest || oi?.amount,
            openInterestUsd: oi?.openInterestUsd || oi?.value,
            ...candidateData,
          });
        } catch (e) {
          return JSON.stringify({ error: e.message, ...candidateData });
        }
      },

      get_coin_technicals: async () => {
        try {
          const [candles1h, candles4h] = await Promise.all([
            bitgetPublic(`/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=1H&limit=100`),
            bitgetPublic(`/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=4H&limit=50`),
          ]);
          const tech1h = computeIndicators(parseCandles(candles1h), '1H');
          const tech4h = computeIndicators(parseCandles(candles4h), '4H');
          return JSON.stringify({ symbol, '1H': tech1h, '4H': tech4h });
        } catch (e) {
          return JSON.stringify({ error: `Technicals failed: ${e.message}` });
        }
      },

      get_coin_info: async () => {
        try {
          // Try to resolve CoinGecko coin ID via search (ticker != CoinGecko ID)
          let coinId = baseSymbol;
          try {
            const searchRes = await fetch(`${MOMENTUM.coingecko_api}/search?query=${baseSymbol}`, { signal: AbortSignal.timeout(5000) });
            if (searchRes.ok) {
              const searchData = await searchRes.json();
              const match = searchData.coins?.find(c => c.symbol?.toLowerCase() === baseSymbol);
              if (match) coinId = match.id;
            }
          } catch {}

          const cgUrl = `${MOMENTUM.coingecko_api}/coins/${coinId}?localization=false&tickers=false&community_data=false&developer_data=false`;
          const res = await fetch(cgUrl, { signal: AbortSignal.timeout(8000) });
          if (!res.ok) return JSON.stringify({ note: 'CoinGecko data unavailable, score tokenomics as 50 (neutral)' });
          const data = await res.json();
          return JSON.stringify({
            name: data.name,
            symbol: data.symbol,
            market_cap: data.market_data?.market_cap?.usd,
            fully_diluted_valuation: data.market_data?.fully_diluted_valuation?.usd,
            circulating_supply: data.market_data?.circulating_supply,
            total_supply: data.market_data?.total_supply,
            max_supply: data.market_data?.max_supply,
            ath: data.market_data?.ath?.usd,
            ath_change_pct: data.market_data?.ath_change_percentage?.usd,
            price_change_7d: data.market_data?.price_change_percentage_7d,
            price_change_30d: data.market_data?.price_change_percentage_30d,
            description: (data.description?.en || '').slice(0, 300),
            categories: data.categories?.slice(0, 5),
          });
        } catch {
          return JSON.stringify({ note: 'CoinGecko unavailable, score tokenomics as 50 (neutral)' });
        }
      },

      get_coin_news: async () => {
        try {
          const name = baseSymbol.toUpperCase();
          const news = await fetchNews(10);
          const relevant = news.filter(n => {
            const text = ((n.title || '') + ' ' + (n.summary || '')).toLowerCase();
            return text.includes(baseSymbol) || text.includes(name);
          });
          if (relevant.length === 0) {
            return JSON.stringify({ note: `No specific news found for ${name}. Score narrative as 50 (neutral).`, general_market_news: news.slice(0, 3).map(n => ({ title: n.title?.slice(0, 100), signal: n.signal || 'neutral', score: n.score || 0 })) });
          }
          return JSON.stringify(relevant.slice(0, 5).map(n => ({
            title: (n.title || '').slice(0, 120),
            score: n.score || 0,
            signal: n.signal || 'neutral',
            source: n.source || '?',
          })));
        } catch {
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
        `Research and evaluate ${symbol} for trading. Fetch all data using your tools, then produce the scoring report.`,
        { trace_id: traceId, max_tokens: 1200, timeout: 60000 }
      );

      const jsonStr = result.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(jsonStr);

      // Persist research to decisions
      try {
        db.insertDecision.run(new Date().toISOString(), 'researcher', 'research', '', '',
          JSON.stringify(parsed), `Research: ${symbol}`, parsed.reasoning || '', '', parsed.total_score || 0, null);
      } catch {}

      console.log(`[Researcher] ${symbol}: score=${parsed.total_score} verdict=${parsed.verdict} direction=${parsed.direction} | ${parsed.reasoning?.slice(0, 80)}`);
      return parsed;
    } catch (err) {
      console.error(`[Researcher] ${symbol} failed:`, err.message);
      return null;
    }
  }

  return { researchCoin };
}
