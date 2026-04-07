<div align="center">

# 诸葛 Zhuge

**Self-hosted autonomous AI trading system with 7 collaborative agents.**

*Observe. Plan. Act. Evolve.*

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![SQLite](https://img.shields.io/badge/SQLite-22_tables-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![Bitget](https://img.shields.io/badge/Bitget-USDT_Futures-00D084)](https://www.bitget.com/)
[![Tests](https://img.shields.io/badge/tests-63_passing-brightgreen)]()
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

[English] [[简体中文](README_CN.md)]

</div>

---

Zhuge is a **7-agent autonomous trading system** that runs 24/7 on a single VPS. It analyzes 540+ crypto futures markets, makes trade decisions through a multi-agent pipeline, executes on Bitget with Kelly-criterion sizing, and continuously evolves its own trading knowledge — all without human intervention.

Not a chatbot wrapper. Not a backtesting framework. A self-improving trading machine that uses real money.

## Why Zhuge?

Most "AI trading bots" are either:
- A single LLM call that outputs buy/sell (no risk management, no learning)
- A rule-based system with "AI" in the name (no actual intelligence)
- A paper-trading demo that never touches real money

**Zhuge is different:**

| | Typical Bot | Zhuge |
|---|---|---|
| Decision making | Single LLM call | 7 agents with distinct roles |
| Risk management | Fixed stop-loss | Fail-closed risk gate + Kelly sizing + 4-level scaling |
| Learning | None | Three-layer knowledge: expert RAG + self-discovered rules + real-time intel |
| Data sources | Single news API | 12 TG channels + Twitter KOL search + 27-source OSINT + Fear & Greed |
| Execution | REST polling every N min | WebSocket event-driven (fills in <1s) |
| Strategy | Hardcoded | AI-generated, auto-backtested, lifecycle-managed |
| Memory | Stateless | Dream Worker checks every 2h, runs at most every 6h when enough notes exist |
| Backtest | LLM-in-the-loop (slow, non-reproducible) | Deterministic condition evaluator (fast, reproducible) |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    PIPELINE (AI-driven scheduling)           │
│                                                              │
│   Crucix 27-source    OKX WebSocket    Intel Stream           │
│        OSINT              prices       (TG + APIs + X)       │
│          │                  │                 │               │
│          └──────────┬───────┘─────────────────┘               │
│                     ▼                                         │
│          ┌─────────────────────┐                              │
│          │   Analyst Agent     │  9 tools, AI chooses which   │
│          │   submit_analysis() │  structured output via fn    │
│          └────────┬────────────┘                              │
│                   ▼                                           │
│          ┌─────────────────────┐                              │
│          │    Risk Agent       │  Hard rules (code-level)     │
│          │   submit_verdict()  │  + LLM soft evaluation       │
│          │   equity from WS    │  Fail-closed: VETO default   │
│          └────────┬────────────┘                              │
│                   ▼                                           │
│          ┌─────────────────────┐                              │
│          │    Executor         │  Kelly sizing (half-Kelly)   │
│          │   4-level scaling   │  1:1:2:4 pyramid             │
│          │   WS event-driven   │  fills → DB in <1s           │
│          └─────────────────────┘                              │
│                                                              │
│   Scanner ─── 540+ pairs ─── Researcher ─── Momentum trade   │
│                                                              │
│   Compound ── review trades ── generate rules ── evolve      │
│   Dream Worker ── merge/prune/distill memories (checks 2h, runs ≤6h)      │
│   Reviewer ── signal accuracy ── lesson extraction            │
│   Strategist ── evaluate AI-generated strategies              │
└─────────────────────────────────────────────────────────────┘
```

## Three-Layer Knowledge Architecture

What makes Zhuge actually learn, not just execute:

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
│  → new strategies: proposed → backtest → active → retired
│
Layer 3: Real-Time Intelligence (Intel Stream)
│  12 TG channels (GramJS, 2min poll) — crypto + energy
│  OpenTwitter API — KOL tweets, keyword search, listing alerts
│  Crucix 27-source OSINT + OKX prices
│  Fear & Greed Index + daily-news aggregator
│
└─ Feedback Loop:
   Layer 1 → influences trades → results feed Layer 2
   → Layer 2 validates Layer 1 effectiveness → evolves
```

## Event-Driven Execution

Primary execution path is event-driven via Bitget Private WebSocket:

```
Order fill     → WS orders channel     → entry/exit price + PnL → reviewer triggered
Position gone  → WS positions channel  → fallback close detection (marks 'closing')
Balance change → WS account channel    → equity cached → risk agent reads from cache

REST sync runs adaptively: 30min when WS is healthy, 5min when it's not.
Analysis loop and WS reconnection still use timers — "event-driven" applies to trade execution, not the whole system.
```

## Intel Stream

Real-time market intelligence from multiple sources, unified into a single feed:

```
TG Channels (GramJS, 2min poll)          Low-freq APIs (6h)
├─ Whale Alert (whale transfers)          ├─ daily-news (6551.io)
├─ Binance Killers (signals)              └─ Fear & Greed Index
├─ Cointelegraph (breaking news)
├─ CryptoNinjas (trade signals)          Agent Tools (on-demand)
├─ Glassnode (on-chain data)              ├─ search_twitter (keyword)
├─ Oil Trading (energy)                   ├─ get_kol_tweets (KOL feed)
├─ Energy Today                           ├─ get_listing_news (exchange)
└─ + 5 more channels                     └─ get_onchain_signals (whale)
         │                                          │
         └─────────────┬───────────────────────────┘
                       ▼
             Intel EventBus
             hash dedup → impact score (0-100) → route
             ≥80: instant analysis trigger
             all: cached for Analyst consumption
```

Each incoming item is deduplicated (MD5), scored by keyword rules (no LLM cost), and routed:
- Score ≥80 triggers an instant analysis cycle (same mechanism as price anomaly detection)
- All items are cached and available to the Analyst via `get_intel_feed` and `fetch_news` tools

## Risk Controls

Zhuge is paranoid by design. Every trade passes through multiple safety gates:

- **Fail-closed risk gate:** Unknown state → VETO. Equity fetch fails → VETO. Parse error → VETO.
- **24h loss limit:** Realized + unrealized > 5% of equity → all trading halted
- **Consecutive loss cooldown:** 3+ losses (5 in scaling mode) → 1h mandatory cooldown
- **Kelly criterion sizing:** Half-Kelly capped at 25% of available margin
- **4-level graduated scaling:** Scout small, scale only with increasing confidence + price confirmation
- **Strategy gate:** New strategies auto-backtest 14 days on creation; win rate <20% → retired immediately
- **Deterministic backtest:** New strategies auto-backtest 14 days on creation, <20% win rate → retired

## Tech Stack

| Component | Choice | Why |
|-----------|--------|-----|
| Runtime | Node.js (ESM) | Single-threaded event loop fits trading pipeline |
| Database | SQLite (WAL mode) | 23 tables, zero ops, single-file backup |
| Vector DB | LanceDB + Ollama | Local embedding, no API costs, 110ms search |
| LLM | OpenAI-compatible API | Per-agent model selection, fallback chain |
| Exchange | Bitget (Private WebSocket) | Event-driven fills, 540+ futures pairs |
| Intel | Intel Stream (TG + OpenTwitter + APIs) | 12 TG channels real-time + Twitter KOL search + Fear & Greed |
| Data | Crucix (27 sources) | Macro + geopolitical + energy in one call |
| Tracing | OpenTelemetry → Jaeger | 3-layer span model for full pipeline visibility |
| Interface | Telegram Bot | Streaming responses, confirmation keyboards, supergroup dashboard |
| Tests | Vitest | 63 cases: indicators, Kelly math, scaling, signals, memory |
| Twitter | OpenTwitter API (ai.6551.io) | KOL monitoring, search, listing alerts — no API key needed |
| TG Monitor | GramJS (MTProto) | 12 public channels: crypto + oil/energy, 2min poll |

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
- OpenAI-compatible LLM endpoint (tested with gpt-4o-mini, gpt-5.4-mini)
- (Optional) Telegram bot token for dashboard + natural language commands

## Project Structure

```
├── index.mjs              — entry point, module wiring
├── pipeline.mjs           — collect → analyze → trade loop
├── config.mjs / db.mjs    — configuration + 22-table SQLite schema
│
├── agent/                 — TG Agent (诸葛) harness
│   ├── cognition/         — compound review, dream worker, condition evaluator
│   ├── knowledge/         — RAG (LanceDB + Ollama)
│   ├── memory/            — indexed recall with frontmatter metadata
│   ├── tools/             — 44 tools (data, system, trade, memory, twitter, intel)
│   ├── push/              — smart push engine + TG dashboard
│   └── observe/           — metrics, logger, health, OTel tracing
│
├── agents/                — 6 autonomous sub-agents
│   ├── analyst.mjs        — 9 tools + submit_analysis (structured output)
│   ├── risk.mjs           — fail-closed gate + submit_verdict
│   ├── researcher.mjs     — coin momentum scoring (4 dimensions)
│   ├── strategist.mjs     — AI strategy evaluation
│   ├── reviewer.mjs       — lesson extraction + signal accuracy
│   └── runner.mjs         — generic agent loop with tool calling
│
├── bitget/                — exchange integration
│   ├── ws.mjs             — Private WebSocket (orders/positions/account)
│   ├── client.mjs         — REST API + signing + rate-limit backoff
│   └── executor.mjs       — Kelly sizing, 4-level scaling, WS handlers
│
├── integrations/          — external data sources
│   ├── intel.mjs          — Intel Stream: TG channels (GramJS) + API pollers
│   ├── data-sources.mjs   — Crucix OSINT + news fetch (backed by Intel cache)
│   └── telegram.mjs       — TG alert sender
│
├── market/                — market data
│   ├── prices.mjs         — OKX WebSocket + anomaly detection
│   ├── scanner.mjs        — 540+ futures scanner
│   └── indicators.mjs     — RSI, EMA, MACD, ATR, Bollinger, Fib (pure math)
│
├── backtest/              — deterministic backtest engine
│   ├── engine.mjs         — candle replay + condition evaluation
│   └── simulator.mjs      — position management + PnL calculation
│
└── tests/                 — 63 unit tests (vitest)
```

## Design Decisions

Some non-obvious choices and why:

- **No LLM in backtest.** LLM output is non-deterministic → backtest results aren't reproducible. Zhuge uses a pure `conditions.mjs` evaluator that's fast and consistent.
- **Structured output via function calls.** Instead of asking LLMs to output JSON text (which fails ~5% of the time), agents call `submit_analysis()` / `submit_verdict()` tools. The schema is enforced by the function definition.
- **Dream Worker limits.** Max 3 deletes + 3 merges + 2 creates per run. Without this, LLM hallucinations can wipe the entire memory in one bad cycle.
- **Strategy lifecycle.** `proposed → active → retired`. High-confidence strategies activate immediately; others stay `proposed` until the next compound review promotes them. All new strategies are auto-backtested on creation — win rate <20% gets retired.
- **WebSocket-first, REST-fallback.** Event-driven execution eliminates the 5-minute blind spot where positions could close without detection. REST polls adaptively: 30min when WS is healthy, 5min when it's not.
- **Pessimistic backtest.** For long positions, check low (stop-loss) before high (take-profit) on each candle. This prevents systematic optimistic bias in backtest results.

## License

AGPL-3.0. See [LICENSE](LICENSE) for details.

---

<div align="center">

Built by [0xEnder](https://x.com/0xenderzcx) — AI Native Builder

*If the code is running, the agents are trading.*

</div>
