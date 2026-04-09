<div align="center">

# 诸葛 Zhuge

**Self-hosted autonomous AI trading system with real-time K-line monitoring, Wei strategy framework, and multi-agent pipeline.**

*Observe. Plan. Act. Evolve.*

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![SQLite](https://img.shields.io/badge/SQLite-30%2B_tables-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![Bitget](https://img.shields.io/badge/Bitget-USDT_Futures-00D084)](https://www.bitget.com/)
[![Tests](https://img.shields.io/badge/tests-66_passing-brightgreen)]()
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

[English] [[简体中文](README_CN.md)]

</div>

---

Zhuge is an **autonomous trading system** that runs 24/7 on a single VPS. It monitors crypto markets in real-time via Bitget WebSocket, analyzes with a multi-agent pipeline, executes with Kelly-criterion sizing, and continuously evolves its own trading strategies — all without human intervention.

Not a chatbot wrapper. Not a backtesting framework. A self-improving trading machine that uses real money.

## Why Zhuge?

Most "AI trading bots" are either:
- A single LLM call that outputs buy/sell (no risk management, no learning)
- A rule-based system with "AI" in the name (no actual intelligence)
- A paper-trading demo that never touches real money

**Zhuge is different:**

| | Typical Bot | Zhuge |
|---|---|---|
| Market data | REST polling every N min | Bitget WebSocket: real-time ticker + 5m/15m/1h K-line with indicator computation |
| Decision making | Single LLM call | Multi-agent pipeline: Analyst → Risk → Strategist → Executor |
| Risk management | Fixed stop-loss | Fail-closed risk gate + Kelly sizing + 4-level scaling + time stops |
| Strategy | Hardcoded rules | Wei framework: probe/skill/defensive with target-position + ladder execution |
| Learning | None | Three-layer knowledge: expert RAG + self-discovered rules + real-time intel |
| Data sources | Single news API | 12 TG channels + Twitter + 27-source OSINT + TradingView MCP + Fear & Greed |
| Execution | REST polling | WebSocket event-driven (fills in <1s) |
| Backtest | LLM-in-the-loop (slow) | Deterministic condition evaluator + ladder simulation + time-stop enforcement |
| Memory | Stateless | Dream Worker consolidation + operational context + long-term recall |

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                         DATA LAYER                               │
│                                                                  │
│   Bitget Public WS          Bitget Private WS     Crucix OSINT   │
│   ├─ ticker (real-time)     ├─ orders (fills)     27 sources     │
│   ├─ candle5m (K-line)      ├─ positions          Intel Stream   │
│   └─ dynamic subscribe      └─ account (equity)   12 TG channels │
│          │                         │                    │        │
│   K-line Monitor ◄────────────────┘                    │        │
│   ├─ 5m/15m/1h indicators                              │        │
│   ├─ Signal detection (EMA/MACD/RSI/BB/Volume)         │        │
│   └─ Pipeline trigger on signal ──────────────┐        │        │
│                                                │        │        │
├────────────────────────────────────────────────▼────────▼────────┤
│                      ANALYSIS PIPELINE                           │
│                                                                  │
│   ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐    │
│   │   Analyst     │──▶│  Risk Agent  │──▶│   Strategist     │    │
│   │  9 tools      │   │  fail-closed │   │  Wei strategies  │    │
│   │  structured   │   │  hard+soft   │   │  conditions eval │    │
│   │  output       │   │  rules       │   │  target-position │    │
│   └──────────────┘   └──────────────┘   └────────┬─────────┘    │
│                                                   │              │
│   Scanner ─── 540+ pairs ─── Researcher ─── Momentum trade      │
│                                                   │              │
├───────────────────────────────────────────────────▼──────────────┤
│                      EXECUTION LAYER                             │
│                                                                  │
│   Executor: Kelly sizing → 4-level scaling (1:1:2:4)             │
│   Wei1.0: trigger mode (open/close)                              │
│   Wei2.0: target-position + ladder orders + time stops           │
│   WS fills → DB in <1s → reviewer triggered                     │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│                      EVOLUTION LAYER                             │
│                                                                  │
│   Compound ── review trades ── generate rules ── evolve          │
│   Dream Worker ── merge/prune/distill memories (checks 2h)      │
│   Reviewer ── signal accuracy ── lesson extraction               │
│   Strategy Selector ── wei family lifecycle management           │
└──────────────────────────────────────────────────────────────────┘
```

## Wei Strategy Framework

Based on the coolish BTC trading theory — not a pixel-perfect copy, but a translation into what the engine can express, backtest, and iterate on.

### Wei1.0 (Trigger Mode)

Three BTC-only strategies that fire discrete open/close signals:

| Strategy | Role | Direction | Leverage | TP / SL |
|----------|------|-----------|----------|---------|
| `wei1_probe_long` | Scout / Normal attack | Long | 2x | 5% / 2% |
| `wei1_skill_add_long` | Size-up / Skill shot | Long | 4x | 7% / 1.8% |
| `wei1_defensive_short` | Defensive hedge | Short | 3x | 6% / 2% |

### Wei2.0 (Target Position Mode)

Three strategies that output target exposure percentages, executed via ladder orders:

| Strategy | Target Exposure | Max Hold | Ladder |
|----------|----------------|----------|--------|
| `wei2_probe_long` | 15% of equity | 48h | 3 rungs |
| `wei2_skill_add_long` | 45% of equity | 24h | 3 rungs |
| `wei2_defensive_short` | -20% of equity | 36h | 3 rungs |

Plus 3 dynamic rules that adjust parameters based on market conditions:
- **Compression**: BBW < 5% + ADX < 20 → reduce target, cap leverage at 2x
- **Breakout**: Aligned bullish structure → increase target +10%, allow leverage 5x
- **Overheat**: Elevated funding + heavy overhead supply → trim target -10%

See [docs/strategies/coolish-btc-framework.md](docs/strategies/coolish-btc-framework.md) for the full theory-to-implementation mapping.

## Real-Time K-line Monitor

All market data flows through a single Bitget Public WebSocket:

```
Bitget Public WS (candle5m + ticker)
    │
    ├─ BTC-USDT / ETH-USDT / SOL-USDT (always on)
    ├─ + any pair via kline_subscribe tool (dynamic)
    │
    ▼
K-line Monitor
    ├─ 5m candle close → compute indicators (RSI, EMA, MACD, BB, OBV, ADX...)
    ├─ Aggregate 5m → 15m → 1h in memory
    ├─ Signal detection: EMA cross, MACD cross, RSI extreme, BB squeeze/breakout, volume spike
    ├─ Snapshot every 60s: early warning on live candle (no trading)
    └─ Signal → trigger full pipeline analysis → may open trade
    
Ticker data → priceCache → anomaly detection (2%/5% flash alerts)
```

诸葛 can dynamically subscribe to any coin via the `kline_subscribe` tool. New subscriptions automatically:
1. Fetch 200 historical candles from Bitget REST API
2. Compute initial indicators across all timeframes
3. Start receiving live WebSocket updates

## TradingView MCP Integration

10 tools from a local TradingView MCP server for cross-validation:

- `tv_market_snapshot` — Global overview (crypto + indices + FX + commodities)
- `tv_coin_analysis` — 30+ indicators per symbol
- `tv_multi_timeframe` — Weekly → Daily → 4H → 1H → 15m alignment
- `tv_top_gainers / tv_top_losers` — Market movers
- `tv_volume_breakout / tv_smart_volume` — Volume analysis
- `tv_bollinger_scan` — BB squeeze detection
- `tv_sentiment` — Reddit community sentiment
- `tv_news` — Reuters, CoinDesk, CoinTelegraph aggregation

## Three-Layer Knowledge Architecture

```
Layer 1: Expert Knowledge (RAG)
│  30+ entries: Wyckoff, SMC, ICT, Kelly, Fib 0.31, OI divergence...
│  Local Ollama embedding + LanceDB vector search
│  Zero API cost, 110ms retrieval
│
Layer 2: Self-Discovered Knowledge (Compound)
│  LLM reviews trade history + veto patterns + signal accuracy
│  → auto-generates rules with confidence + evidence
│  → rules directly control execution params (leverage, TP/SL, margin)
│  → strategy lifecycle: proposed → backtest → active → retired
│
Layer 3: Real-Time Intelligence (Intel Stream)
│  12 TG channels (GramJS, 2min poll) — crypto + energy
│  OpenTwitter API — KOL tweets, keyword search, listing alerts
│  Crucix 27-source OSINT + Bitget WebSocket prices
│  Fear & Greed Index + daily-news aggregator
│
└─ Feedback Loop:
   Layer 1 → influences trades → results feed Layer 2
   → Layer 2 validates Layer 1 effectiveness → evolves
```

## Risk Controls

Zhuge is paranoid by design. Every trade passes through multiple safety gates:

- **Fail-closed risk gate:** Unknown state → VETO. Equity fetch fails → VETO. Parse error → VETO.
- **24h loss limit:** Realized + unrealized > 5% of equity → all trading halted
- **Consecutive loss cooldown:** 3+ losses (5 in scaling mode) → 1h mandatory cooldown
- **Scout relaxation:** Scout (smallest) positions bypass loss cooldown — worth trying even after losses
- **Kelly criterion sizing:** Half-Kelly capped at 25% of available margin, $5 notional minimum
- **4-level graduated scaling:** Scout small, scale only with increasing confidence + price confirmation
- **Time stops:** `max_hold_minutes` enforced — positions expire if thesis doesn't play out
- **Strategy gate:** New strategies auto-backtest 14 days; win rate <20% → retired immediately
- **Credential isolation:** exec_shell blocked from reading .env and sensitive files
- **Conversation sanitization:** Dangling tool calls auto-cleaned to prevent LLM 400 errors

## Tech Stack

| Component | Choice | Why |
|-----------|--------|-----|
| Runtime | Node.js 20+ (ESM) | Single-threaded event loop fits trading pipeline |
| Database | SQLite (WAL mode) | 30+ tables, zero ops, single-file backup |
| Vector DB | LanceDB + Ollama | Local embedding, no API costs, 110ms search |
| LLM | OpenAI-compatible API | Per-agent model selection, fallback chain |
| Exchange | Bitget (Public + Private WS) | Real-time K-line + event-driven fills, 540+ futures |
| Market Data | Bitget Public WebSocket | Unified source: ticker + candle5m, dynamic subscription |
| TradingView | Local MCP server (streamable-http) | 10 tools for cross-validation, no API key needed |
| Intel | Intel Stream (TG + OpenTwitter + APIs) | 12 TG channels + Twitter KOL + Fear & Greed |
| Data | Crucix (27 sources) | Macro + geopolitical + energy in one call |
| Tracing | OpenTelemetry → Jaeger | 3-layer span model: pipeline → agent → tool |
| Interface | Telegram Bot | Streaming responses, confirmation keyboards, supergroup dashboard |
| Tests | Vitest | 66 cases: indicators, Kelly math, scaling, signals, strategies, features |

## Quick Start

```bash
git clone https://github.com/enderzcx/Zhuge.git
cd Zhuge
cp .env.example .env
# Fill in: Bitget API keys, LLM endpoint, Telegram bot token (optional)
npm install
node index.mjs
```

### Requirements

- Node.js 20+
- Ollama with `nomic-embed-text` model (for RAG knowledge search)
- Bitget API key with USDT-FUTURES permission
- OpenAI-compatible LLM endpoint (tested with gpt-5.4-mini)
- (Optional) Telegram bot token for dashboard + natural language commands
- (Optional) TradingView MCP server for cross-validation tools

## Project Structure

```
├── index.mjs              — entry point, module wiring
├── pipeline.mjs           — collect → analyze → trade loop
├── config.mjs / db.mjs    — configuration + 30-table SQLite schema
│
├── agent/                 — TG Agent (诸葛) harness
│   ├── cognition/         — strategy selector, target-position engine,
│   │                        feature builder, conditions evaluator,
│   │                        compound review, dream worker
│   ├── knowledge/         — RAG (LanceDB + Ollama)
│   ├── memory/            — indexed recall with frontmatter metadata
│   ├── tools/             — data, system, trade, memory, schedule, tradingview
│   ├── push/              — smart push engine + TG dashboard
│   ├── telegram/          — streaming editMessage + confirmation UI
│   └── observe/           — metrics, logger, health, OTel tracing
│
├── agents/                — pipeline sub-agents
│   ├── analyst.mjs        — 9 tools + submit_analysis (structured output)
│   ├── risk.mjs           — fail-closed gate + submit_verdict (scout relaxation)
│   ├── researcher.mjs     — coin momentum scoring (4 dimensions)
│   ├── strategist.mjs     — Wei strategy evaluation + target-position decisions
│   ├── reviewer.mjs       — lesson extraction + signal accuracy
│   └── runner.mjs         — generic agent loop with tool calling
│
├── bitget/                — exchange integration
│   ├── ws.mjs             — Private WebSocket (orders/positions/account)
│   ├── client.mjs         — REST API + signing + rate-limit backoff
│   └── executor.mjs       — Kelly sizing, 4-level scaling, target reconciliation,
│                            ladder orders, WS event handlers
│
├── market/                — market data
│   ├── kline-monitor.mjs  — Bitget Public WS: candle5m + ticker subscription,
│   │                        5m/15m/1h indicator computation, signal detection
│   ├── prices.mjs         — price cache + anomaly detection (fed by kline-monitor)
│   ├── scanner.mjs        — 540+ futures scanner + momentum pipeline
│   └── indicators.mjs     — 30+ indicators: RSI, EMA, MACD, ATR, BB, Fib,
│                            Ichimoku, ADX, OBV, VWAP, Market Structure, OB, FVG
│
├── backtest/              — deterministic backtest engine
│   ├── engine.mjs         — candle replay + condition eval + ladder simulation
│   ├── simulator.mjs      — position management + PnL calculation
│   └── market-state-loader.mjs — Bitget market state snapshots for backtest
│
├── docs/
│   ├── strategies/        — coolish BTC framework spec
│   └── architecture/      — refactor plan (codex-reviewed)
│
└── tests/                 — 66 unit tests (vitest)
```

## Design Decisions

- **No LLM in backtest.** LLM output is non-deterministic → backtest results aren't reproducible. Zhuge uses a pure `conditions.mjs` evaluator.
- **Structured output via function calls.** Agents call `submit_analysis()` / `submit_verdict()` instead of outputting JSON text. Schema enforced by tool definition.
- **Dream Worker limits.** Max 3 deletes + 3 merges + 2 creates per run. Prevents LLM hallucinations from wiping memory.
- **Wei strategy framework.** Not a single mega-strategy. Three sub-strategies (probe/skill/defensive) with independent sizing, lifecycle, and conditions. Compound evolves parameters, not the structure.
- **Bitget-unified data.** All market data from one exchange: ticker + K-line + private events. No OKX/Bitget split — eliminates price divergence and reduces connection count.
- **Signal detection: rules + AI.** Hardcoded signals (EMA cross, etc.) are fast, deterministic triggers. AI (analyst) makes the actual trading decision. Best of both worlds.
- **Pessimistic backtest.** For long positions, check low (stop-loss) before high (take-profit) on each candle.
- **Conversation sanitization.** Auto-remove dangling tool calls from history to prevent LLM API 400 errors on crash recovery.

## License

AGPL-3.0. See [LICENSE](LICENSE) for details.

---

<div align="center">

Built by [0xEnder](https://x.com/0xenderzcx) — AI Native Builder

*If the code is running, the agents are trading.*

</div>
