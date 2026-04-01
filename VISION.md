# TradeAgent — Private Autonomous Trading AI

> One goal: make money consistently. Everything else is noise.

---

## What This Is

A private, autonomous AI trading system that runs 24/7 on a VPS. No users, no UI polish, no token — just a machine that finds edges and exploits them.

Not a product. Not open source. A personal money printer.

---

## Current Capabilities

```
Data Center (27+ sources)
    ↓
7 AI Agents analyze every 30 minutes
    ↓
Bitget CEX: 540+ futures pairs, 10x leverage
    ↓
Auto-execute with risk controls
```

### What's Working
- 5-dimensional analysis: macro + technical + news + OI + Fib 0.31
- Wilder RSI, MACD, ATR, Bollinger, EMA20 on 1H + 4H
- OI divergence detection (price vs open interest)
- Funding rate extreme detection (crowded longs/shorts)
- Risk Agent: fail-closed, 5% daily loss limit, 3-loss cooldown
- Scanner: 540+ pairs → RSI extreme filter → LLM picks best → order with TP/SL
- Auto-cancel stale orders when better opportunity found
- Self-evolution: inject win rate into Analyst, auto-conservative on losing streaks
- Trading mutex: no concurrent orders
- Position dedup: no double-up same direction

### What's Not Working Yet
- Only $2.69 in Bitget (can't do meaningful trades)
- Scanner finds opportunities but limited by capital
- No meme coin scanning
- No social sentiment data
- Stock mode disabled (saving tokens, no active use)

---

## North Star Metrics

| Metric | Target |
|--------|--------|
| Monthly return | > 5% (after fees) |
| Win rate | > 55% |
| Profit factor | > 1.5 (avg win / avg loss) |
| Max drawdown | < 15% |
| Sharpe ratio | > 1.0 |
| Daily token cost | < 600K tokens |

---

## Roadmap

### Phase 1: Capital Efficiency (Now)
**Problem:** $2.69 can't do anything meaningful.

- [ ] Fund Bitget account ($100-500)
- [ ] Optimize position sizing: Kelly criterion instead of all-in
- [ ] Close tracking: auto-detect filled orders → update trades table → calculate PnL
- [ ] Compound: reinvest profits into larger positions

### Phase 2: Meme Scanner
**Problem:** Missing the biggest alpha — new token launches.

```
Data Center adds:
├── DEXScreener API (free, no key)
│   ├── /latest/boosted — trending new tokens
│   └── /dex/pairs/{chain}/{pair} — price + liquidity
├── Birdeye API
│   └── Token top movers, whale tracking
└── Honeypot detector
    └── Buy/sell tax check before entry

Meme Scanner logic:
├── Every 5 min: scan new pairs on Base + BSC
├── Filter: liquidity > $10k, age > 30min, not honeypot
├── Score: volume velocity + social mentions + holder distribution
├── Execute: $5-10 per trade, auto TP at 2x/5x, timeout exit at 4h
└── Risk: max 3 concurrent meme positions, max 10% of portfolio
```

### Phase 3: Social Sentiment Layer
**Problem:** Trading only on price + macro. Missing crowd psychology.

```
Data Center adds:
├── Twitter/X API — KOL mention tracking, sentiment scoring
├── Reddit API — r/cryptocurrency + r/wallstreetbets sentiment
├── Telegram channel monitoring — alpha groups, whale alerts
└── Polymarket — event probability as trading signal

Integration:
├── Analyst gets 6th dimension: social sentiment (weighted 10%)
├── Meme Scanner uses social velocity for entry timing
└── Contrarian signal: when everyone is bullish, prepare to sell
```

### Phase 4: Multi-Exchange
**Problem:** Single exchange = single point of failure.

```
Execution adds:
├── Bybit — backup for Bitget downtime
├── Hyperliquid — on-chain perps, deeper liquidity
└── Smart routing: pick best funding rate across exchanges

Benefits:
├── Funding rate arb: long on negative funding, short on positive
├── Cross-exchange spread capture
└── Never miss a trade due to one exchange being down
```

### Phase 5: Strategy Tournament
**Problem:** Don't know which strategy actually works best.

```
Multiple strategies paper-trade in parallel:
├── Strategy A: pure technical (RSI + EMA + MACD)
├── Strategy B: macro-driven (VIX + Crucix + news)
├── Strategy C: OI divergence only
├── Strategy D: Fib 0.31 + left-side entries
├── Strategy E: meme momentum (social + volume)

Weekly ranking:
├── Real capital follows top 2 strategies
├── Bottom strategy gets replaced with new variant
└── Continuous evolution via competition
```

### Phase 6: Prediction & Backtesting
**Problem:** No way to validate strategies before risking capital.

```
Backtesting engine:
├── Replay historical candles + signals
├── Simulate AI decisions against actual price moves
├── Calculate hypothetical PnL, drawdown, Sharpe
└── Compare against buy-and-hold benchmark

Prediction scoring:
├── Every analysis tagged with predicted direction
├── Track accuracy at 15min / 1h / 4h marks
├── Weight future decisions by source accuracy
└── Signal sources with < 40% accuracy auto-downweighted
```

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                 DATA CENTER (VPS)                     │
│                                                       │
│  ┌──────────────────────────────────────────────┐    │
│  │ Data Sources                                  │    │
│  │ Crucix 27src | OpenNews | OKX WS | Bitget    │    │
│  │ [Future: DEXScreener | Birdeye | Twitter]    │    │
│  └──────────────────┬───────────────────────────┘    │
│                     ▼                                 │
│  ┌──────────────────────────────────────────────┐    │
│  │ AI Pipeline (30min cycle)                     │    │
│  │                                                │    │
│  │  Analyst (6 tools) → Risk (fail-closed)       │    │
│  │       ↓                    ↓                   │    │
│  │  Strategist          BitgetExec (mutex)       │    │
│  │       ↓                                        │    │
│  │  Reviewer (3h + weekly)                       │    │
│  └──────────────────┬───────────────────────────┘    │
│                     ▼                                 │
│  ┌──────────────────────────────────────────────┐    │
│  │ Scanner (30min, RSI-filtered)                 │    │
│  │ 540+ pairs → extreme RSI → LLM → order       │    │
│  └──────────────────────────────────────────────┘    │
│                     ▼                                 │
│  ┌──────────────────────────────────────────────┐    │
│  │ SQLite (11 tables)                            │    │
│  │ trades | decisions | candles | lessons | ...   │    │
│  └──────────────────────────────────────────────┘    │
│                     ▼                                 │
│  ┌──────────────────────────────────────────────┐    │
│  │ API (29 routes, port 3200)                    │    │
│  │ Also serves RIFI web (chain product)          │    │
│  └──────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

---

## Principles

1. **Risk first.** Never risk more than you can lose. 5% daily limit. Fail-closed.
2. **Data over opinion.** RSI, OI, funding rate > "I think it's going up."
3. **Left-side entries.** Buy support, don't chase breakout. SL:TP >= 1:2 always.
4. **Learn from losses.** Every losing trade generates a lesson injected into future prompts.
5. **Speed doesn't matter.** 30min cycles are fine. Consistency > milliseconds.
6. **Capital preservation.** Making 0% is better than losing 5%. Conservative is not weak.
7. **One thing at a time.** Don't over-diversify with $100. Focus capital on best setup.

---

## File Structure

```
TradeAgent/
├── index.mjs           — entry point + wiring
├── config.mjs          — env + constants
├── db.mjs              — SQLite 11 tables
├── llm.mjs             — LLM wrapper
├── pipeline.mjs        — 30min analysis cycle
├── agents/
│   ├── runner.mjs      — generic agent loop
│   ├── analyst.mjs     — 6-tool market analyst
│   ├── risk.mjs        — fail-closed risk gate
│   ├── strategist.mjs  — strategy evaluator
│   ├── reviewer.mjs    — 3h patrol + weekly review
│   └── message-bus.mjs — inter-agent messaging
├── bitget/
│   ├── client.mjs      — API client
│   ├── executor.mjs    — trade execution + mutex
│   └── routes.mjs      — proxy API routes
├── market/
│   ├── prices.mjs      — OKX WebSocket + candles
│   ├── indicators.mjs  — EMA/RSI/MACD/ATR/BB/Fib031
│   ├── scanner.mjs     — 540+ pair scanner
│   └── signals.mjs     — accuracy tracking
├── integrations/
│   ├── data-sources.mjs — Crucix + OpenNews
│   ├── lifi.mjs        — cross-chain (shared with RIFI)
│   └── telegram.mjs    — alerts
└── routes/             — 7 API route files
```
