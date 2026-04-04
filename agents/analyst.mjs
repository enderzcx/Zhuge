/**
 * Analyst agent: system prompt builder, tools, and executors.
 */

export function createAnalyst({ db, config, bitgetClient, dataSources, priceStream, indicators }) {
  const { fetchCrucix, fetchNews, compactCrucixObj } = dataSources;
  const { bitgetPublic } = bitgetClient;
  const { parseCandles, computeIndicators } = indicators;
  const { priceCache } = priceStream;

  const PRICE_PAIRS = config.PRICE_PAIRS || ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'];

  function buildAnalystSystemPrompt(mode) {
    const roleLabel = mode === 'stock' ? 'senior US equity market intelligence analyst' : 'senior crypto trading intelligence analyst';
    const focusLabel = mode === 'stock'
      ? 'US stock market conditions. Focus on S&P500, VIX, sector rotation, rate expectations, geopolitical impact on equities.'
      : 'crypto market conditions. Focus on BTC, ETH, macro risk, on-chain signals, and sentiment.';
    const sentimentField = mode === 'stock' ? '"stock_sentiment"' : '"crypto_sentiment"';
    const pushRule = mode === 'stock'
      ? 'VIX spike >25, S&P500 drop >2%, major Fed action, geopolitical escalation'
      : 'VIX spike, major hack, regulation news, 5%+ price move';

    // Dynamic lesson injection from learning loop
    let lessonsBlock = '';
    try {
      const activeLessons = db.prepare('SELECT lesson, category FROM lessons WHERE active = 1 ORDER BY created_at DESC LIMIT 10').all();
      if (activeLessons.length > 0) {
        lessonsBlock = `\n\nLessons from past performance (apply these to your analysis):\n${activeLessons.map(l => `- [${l.category}] ${l.lesson}`).join('\n')}`;
      }
    } catch {}

    // Performance-based mode adjustment
    let performanceBlock = '';
    try {
      const closed = db.prepare("SELECT pnl FROM trades WHERE status = 'closed' AND (pnl IS NOT NULL AND pnl != 0) ORDER BY closed_at DESC LIMIT 20").all();
      const wins = closed.filter(t => t.pnl > 0);
      const winRate = closed.length > 0 ? (wins.length / closed.length) : 0.5;
      let consecutiveLosses = 0;
      for (const t of closed) { if (t.pnl < 0) consecutiveLosses++; else break; }
      if (consecutiveLosses >= 5 || winRate < 0.25) {
        performanceBlock = `\n\n⚠️ PERFORMANCE WARNING: Win rate ${(winRate * 100).toFixed(0)}%, ${consecutiveLosses} consecutive losses. Be cautious: only recommend strong_buy/strong_sell if confidence > 70. Still allow increase_exposure/reduce_exposure at confidence > 55 for scout entries.`;
      } else if (winRate > 0.6) {
        performanceBlock = `\n\nPerformance is strong (${(winRate * 100).toFixed(0)}% win rate). Maintain current approach.`;
      }
    } catch {}

    return `You are a ${roleLabel}. You have tools to fetch real-time data. ALWAYS use multiple data sources before making a decision.

Your workflow:
1. Call get_crucix_data for macro/market data (VIX, S&P500, gold, geopolitics)
2. Call get_crypto_news for AI-scored news sentiment
3. Call get_prices for real-time prices + 5min change
4. Call get_technical_indicators for BTCUSDT, ETHUSDT, and SOLUSDT (3 calls) — this gives you EMA, RSI, MACD, ATR, Bollinger, Fib 0.31, OI, funding rate for each
5. Call get_trade_performance to see recent win rate and calibrate your confidence
6. Compare all 3 assets and pick the single best trading opportunity
7. Synthesize ALL data into your analysis

KEY ANALYSIS FRAMEWORK (5 dimensions, score each):
- Macro (25%): VIX, US equities (SPX/QQQ/DIA/IWM), bonds (TLT/HYG/LQD), Fed rate (FRED), geopolitical tension (GDELT), chokepoints
- Technical (25%): EMA20 trend, RSI oversold/overbought, MACD cross, Bollinger position
- News/Sentiment (20%): AI-scored news direction + relevance
- On-chain/OI (15%): Open Interest trend vs price (divergence = reversal signal), funding rate extreme
- Fib 0.31 (15%): Price proximity to 0.31 level — this is a high-precision S/R level

US EQUITY BREADTH SIGNALS:
- QQQ (Nasdaq 100): tech/growth sentiment. QQQ leading SPX down = risk-off rotation.
- DIA (Dow Jones): large-cap/defensive signal. DIA holding while QQQ drops = rotation to defensives.
- IWM (Russell 2000): small-cap risk appetite. IWM falling faster than SPX = risk-off broadening.
- Rule: QQQ + IWM both falling > 1% = broad risk-off, bearish crypto. IWM outperforming = risk-on, bullish.

BOND MARKET SIGNALS (most important macro leading indicator):
- TLT (20Y Treasury ETF): TLT falling = yields rising = risk-off = crypto bearish. TLT rising = yields falling = risk-on.
- HYG (High Yield Bond ETF): HYG falling = credit stress = risk-off = sell crypto. HYG rising = credit healthy = risk-on.
- LQD (Investment-Grade Bond ETF): LQD falling confirms credit stress beyond junk bonds = systemic risk signal.
- Rule: If TLT AND HYG both falling simultaneously → strong bearish macro signal (raise macro_risk_score by 15-20)
- Rule: If HYG AND LQD both falling → credit stress spreading to IG = severe risk-off (raise macro_risk_score by 20-25)
- Rule: If TLT falling but HYG stable/rising → rates rising but not credit stress → neutral/mild bearish

FED/MACRO SIGNALS (FRED data):
- Fed rate > 4.5% = tight monetary policy = headwind for risk assets
- Fed rate falling = tailwind for crypto (more liquidity)
- CPI > 3% = inflation sticky = Fed stays tight = bearish for crypto
- CPI < 2.5% = inflation cooling = Fed may cut = bullish

GEOPOLITICAL SIGNALS:
- GDELT tension > 70 = elevated geopolitical risk → raise macro_risk_score
- Chokepoints disrupted (Hormuz/Suez/Panama) → energy prices spike → stagflation risk → crypto volatile

CRITICAL RULES for 0.31 and OI:
- Fib 0.31: Price approaching 0.31 from below = strong resistance (expect pullback, prepare short). Price approaching 0.31 from above = strong support (expect bounce, prepare long). Most precise on 1H/4H.
- OI interpretation:
  * Price UP + OI DOWN = bullish divergence (go-live rally, shorts liquidated)
  * Price UP + OI UP = leverage piling, potential trap (caution)
  * Price DOWN + OI UP = bears adding, bearish continuation
  * Price DOWN + OI DOWN = deleveraging, potential bottom forming
- Funding rate > 0.03% = longs overcrowded (bearish). Funding < -0.01% = shorts crowded (bullish squeeze potential).

PROACTIVE TRADING — you are NOT passive:
- If technical setup is clear (RSI extreme + EMA support/resistance + OI confirms), recommend action even without FLASH news
- Include specific entry_zone, stop_loss, take_profit in your output
- SL:TP ratio must be >= 1:2 (risk $1 to make $2+)
- Left-side entries preferred: buy at support BEFORE confirmation, not after breakout

SYMBOL SELECTION (crypto mode):
- You MUST compare BTC, ETH, and SOL technical setups and pick the single best opportunity
- Prefer: strongest RSI signal, clearest trend, best risk/reward ratio
- If no asset has a clear setup, recommend "hold" with the most interesting asset as symbol
- Output your chosen symbol as "BTCUSDT", "ETHUSDT", or "SOLUSDT"

Produce a JSON object with these exact fields:
{
  "symbol": "BTCUSDT" | "ETHUSDT" | "SOLUSDT",
  "symbol_reason": "<one-line Chinese: why this asset over the other two>",
  "macro_risk_score": <0-100, higher = more risk>,
  ${sentimentField}: <0-100, higher = more bullish>,
  "technical_bias": "long" | "short" | "neutral",
  "recommended_action": "strong_buy" | "increase_exposure" | "hold" | "reduce_exposure" | "strong_sell",
  "confidence": <0-100>,
  "entry_zone": { "low": <price>, "high": <price> },
  "stop_loss": <price or null>,
  "take_profit": <price or null>,
  "alerts": [
    { "level": "FLASH|PRIORITY|ROUTINE", "signal": "<one-line Chinese description>", "source": "<data source>", "relevance": <0-100> }
  ],
  "briefing": "<3-4 sentence Chinese briefing. ${focusLabel} Include specific prices, key indicator values (RSI, EMA, OI trend), and the reasoning chain. Be actionable.>",
  "push_worthy": <true if confidence >= 55 AND action is not hold>,
  "push_reason": "<if push_worthy, one-line Chinese reason>",
  "key_levels": { "support": <price>, "resistance": <price>, "fib_031": <price> }
}

Rules:
- alerts: max 6, sorted by relevance desc.
- briefing: Chinese only, no markdown. Include specific prices/indicator values.
- push_worthy: true when confidence >= 55 AND recommended_action is NOT hold (be proactive! We use graduated position sizing now — small scout positions at lower confidence, scaling up as confidence grows)
- The system now uses 4-level position scaling (1:1:2:4). Lower confidence = smaller position. Don't hold back on directional signals just because confidence isn't extremely high.
- Be precise with numbers
- Output ONLY the JSON after gathering data, no other text.${lessonsBlock}${performanceBlock}`;
  }

  const ANALYST_TOOLS = [
    {
      type: 'function',
      function: {
        name: 'get_crucix_data',
        description: 'Fetch macro & market data from Crucix 27-source OSINT engine (VIX, BTC, ETH, S&P500, gold, energy, conflicts, weather, TG urgent)',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_crypto_news',
        description: 'Fetch latest AI-scored crypto/finance news with sentiment signals',
        parameters: {
          type: 'object',
          properties: { limit: { type: 'number', description: 'Number of news items (default 10, max 15)' } },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_prices',
        description: 'Get real-time prices from OKX WebSocket for BTC-USDT, ETH-USDT, SOL-USDT with 5-minute change data',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_technical_indicators',
        description: 'Fetch technical indicators for BTC and ETH from Bitget: 1H and 4H candles with EMA20, RSI(7/14), MACD, ATR, Bollinger Bands, Fibonacci 0.31 level, support/resistance, and Open Interest + funding rate. Essential for precise entry/exit timing.',
        parameters: {
          type: 'object',
          properties: {
            symbol: { type: 'string', description: 'Symbol (default: BTCUSDT). Options: BTCUSDT, ETHUSDT, SOLUSDT', enum: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_trade_performance',
        description: 'Get recent trading performance: win rate, PnL, consecutive losses, recent trades. Use this to calibrate confidence and aggressiveness.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
  ];

  const ANALYST_EXECUTORS = {
    get_crucix_data: async () => {
      const data = await fetchCrucix();
      return data ? JSON.stringify(compactCrucixObj(data)) : JSON.stringify({ error: 'Crucix unavailable' });
    },
    get_crypto_news: async (args) => {
      const news = await fetchNews(args.limit || 10);
      if (!news.length) return JSON.stringify({ news: [] });
      return JSON.stringify(news.slice(0, 15).map(n => ({
        title: (n.title || n.headline || '').slice(0, 120),
        score: n.score || n.aiRating?.score || 0,
        signal: n.signal || n.aiRating?.signal || 'neutral',
        source: n.source || '?',
      })));
    },
    get_prices: async () => {
      const prices = {};
      for (const pair of PRICE_PAIRS) {
        const c = priceCache[pair];
        prices[pair] = { price: c.price, change5m: (c.change5m * 100).toFixed(2) + '%', high5m: c.high5m, low5m: c.low5m };
      }
      return JSON.stringify(prices);
    },
    get_technical_indicators: async (args) => {
      const symbol = args.symbol || 'BTCUSDT';
      try {
        // Fetch 1H and 4H candles in parallel
        const [candles1h, candles4h, oiData, tickerData] = await Promise.all([
          bitgetPublic(`/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=1H&limit=100`),
          bitgetPublic(`/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=4H&limit=50`),
          bitgetPublic(`/api/v2/mix/market/open-interest?symbol=${symbol}&productType=USDT-FUTURES`).catch(() => null),
          bitgetPublic(`/api/v2/mix/market/ticker?symbol=${symbol}&productType=USDT-FUTURES`).catch(() => null),
        ]);

        const parse1h = parseCandles(candles1h);
        const parse4h = parseCandles(candles4h);

        // Compute indicators for 1H
        const tech1h = computeIndicators(parse1h, '1H');
        // Compute indicators for 4H
        const tech4h = computeIndicators(parse4h, '4H');

        // Open Interest (API returns array)
        const oiObj = Array.isArray(oiData) ? oiData[0] : oiData;
        const oi = oiObj ? {
          amount: oiObj.openInterest || oiObj.amount,
          value_usd: oiObj.openInterestUsd || oiObj.value,
        } : null;

        // Funding rate from ticker
        const ticker = Array.isArray(tickerData) ? tickerData[0] : tickerData;
        const fundingRate = ticker?.fundingRate ? parseFloat(ticker.fundingRate) : null;

        return JSON.stringify({
          symbol,
          '1H': tech1h,
          '4H': tech4h,
          open_interest: oi,
          funding_rate: fundingRate,
          funding_rate_pct: fundingRate ? (fundingRate * 100).toFixed(4) + '%' : null,
        });
      } catch (err) {
        return JSON.stringify({ error: `Tech indicators failed: ${err.message}` });
      }
    },
    get_trade_performance: async () => {
      try {
        const closed = db.prepare('SELECT * FROM trades WHERE status = ? ORDER BY closed_at DESC LIMIT 20').all('closed');
        const wins = closed.filter(t => t.pnl > 0);
        const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
        let consecutiveLosses = 0;
        for (const t of closed) { if (t.pnl <= 0) consecutiveLosses++; else break; }
        const avgWinPnl = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
        const losses = closed.filter(t => t.pnl <= 0);
        const avgLossPnl = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
        return JSON.stringify({
          total_closed: closed.length,
          wins: wins.length,
          win_rate: closed.length > 0 ? ((wins.length / closed.length) * 100).toFixed(1) + '%' : 'N/A',
          total_pnl: totalPnl.toFixed(4),
          avg_win: avgWinPnl.toFixed(4),
          avg_loss: avgLossPnl.toFixed(4),
          profit_factor: avgLossPnl !== 0 ? Math.abs(avgWinPnl / avgLossPnl).toFixed(2) : 'N/A',
          consecutive_losses: consecutiveLosses,
          recent_5: closed.slice(0, 5).map(t => ({ pair: t.pair, side: t.side, pnl: t.pnl, closed_at: t.closed_at })),
          guidance: consecutiveLosses >= 3 ? 'CONSERVATIVE: 3+ consecutive losses, reduce position size and only take high-confidence setups'
            : wins.length / Math.max(closed.length, 1) < 0.4 ? 'CAUTIOUS: win rate below 40%, tighten entry criteria'
            : 'NORMAL: performance acceptable',
        });
      } catch { return JSON.stringify({ error: 'Trade stats unavailable' }); }
    },
  };

  return { buildAnalystSystemPrompt, ANALYST_TOOLS, ANALYST_EXECUTORS };
}
