# TradeAgent

Autonomous AI trading system — 7 agents, real money, self-learning.

## What It Does

A multi-agent system that trades crypto futures 24/7 on Bitget CEX. The TG Agent is the commander; 5 sub-agents (analyst, risk, researcher, strategist, reviewer) run autonomously. A compound knowledge engine lets the system discover trading patterns from its own history and write rules that feed back into future decisions — zero human-written trading rules.

## Architecture

```
TG Agent (commander, natural language interface)
  │
  ├── Pipeline (every 30min)
  │     ├── Data Collection (Crucix 27-source OSINT + OpenNews + OKX WebSocket)
  │     ├── Analyst Agent (macro/technical/sentiment/on-chain/Fib analysis)
  │     ├── Risk Agent (fail-closed: 24h loss >5%, 3 consecutive losses → VETO)
  │     ├── Executor (Kelly sizing, 4-level graduated scaling, TP/SL)
  │     └── Strategist Agent (strategy evaluation)
  │
  ├── Scanner (every 30min)
  │     ├── 540+ futures market scan
  │     ├── Researcher Agent (volume/price action/funding/narrative scoring)
  │     └── Momentum trading (auto open/close)
  │
  ├── Compound Knowledge (every 10 closed trades)
  │     ├── LLM self-review of trade history
  │     ├── Pattern discovery → rule generation
  │     └── Rules injected into next decision cycle
  │
  ├── Reviewer Agent (every 3h)
  │     ├── Signal accuracy scoring
  │     └── Lesson extraction
  │
  └── Observability
        ├── 19 metric types (SQLite time-series)
        ├── Structured JSON logging (31 event types)
        ├── OpenTelemetry → Jaeger (3-layer span model)
        └── Health alerts → TG (heap/mem/event loop thresholds)
```

## Tech Stack

- **Runtime:** Node.js (ESM), single VPS, PM2
- **Database:** SQLite (better-sqlite3), 19 tables, WAL mode
- **LLM:** OpenAI-compatible API (gpt-5.4-mini default, per-agent model selection)
- **Exchange:** Bitget CEX (futures + spot)
- **Data:** Crucix OSINT, OpenNews, OKX WebSocket, Telegram channels
- **Tracing:** OpenTelemetry → Jaeger (OTLP HTTP)
- **Interface:** Telegram Bot (streaming responses, inline confirmation, supergroup dashboard)
- **Tests:** Vitest (60 cases covering indicators, Kelly, scaling, signals)

## Structure

```
├── index.mjs              — entry point, module wiring, graceful shutdown
├── pipeline.mjs           — main loop: collect → analyze → trade (30min cycle)
├── config.mjs             — env config (dotenv)
├── db.mjs                 — SQLite schema (19 tables, single source of truth)
│
├── agent/                 — TG Agent harness
│   ├── llm.mjs            — LLM streaming + fallback
│   ├── loop.mjs           — async generator agent loop (8 round max)
│   ├── history.mjs        — conversation history + 3-layer compression
│   ├── model-select.mjs   — per-conversation model selection + latch
│   ├── tools/             — 18 tools (data, system, trade, memory)
│   ├── telegram/          — TG bot + streaming + confirmation keyboards
│   ├── prompts/           — system prompt assembly (static + dynamic injection)
│   ├── cognition/         — compound knowledge + decision provenance
│   ├── push/              — smart push (FLASH/TRADE/ERROR) + TG dashboard
│   ├── observe/           — metrics, logger, health monitor, OTel tracing
│   └── memory/            — agent memory files (context, directives, lessons)
│
├── agents/                — 5 autonomous sub-agents
│   ├── analyst.mjs        — 5-dimension market analysis (macro/tech/sentiment/chain/fib)
│   ├── risk.mjs           — fail-closed risk gate (hard rules + LLM soft check)
│   ├── researcher.mjs     — new coin momentum scoring (4 dimensions)
│   ├── strategist.mjs     — active strategy evaluation
│   └── reviewer.mjs       — post-trade lesson extraction + signal accuracy
│
├── bitget/                — CEX integration
│   ├── client.mjs         — authenticated API + latency metrics
│   ├── executor.mjs       — Kelly sizing, 4-level scaling, trade sync
│   └── routes.mjs         — HTTP API for manual orders
│
├── market/                — market data
│   ├── prices.mjs         — OKX WebSocket + anomaly detection
│   ├── scanner.mjs        — 540+ futures scanner + momentum pipeline
│   ├── indicators.mjs     — RSI, EMA, MACD, ATR, Bollinger, Fib (pure math)
│   └── signals.mjs        — historical signal accuracy tracking
│
└── tests/                 — unit tests (vitest)
    ├── indicators.test.mjs
    ├── scaling.test.mjs
    └── signals.test.mjs
```

## Run

```bash
cp .env.example .env  # fill API keys
npm install
npm start
```

## Key Design Decisions

- **Prompts as control plane:** Agent behavior defined in .md files, not hardcoded if/else
- **Fail-closed safety:** All dangerous operations require TG confirmation. Unknown tools blocked by default
- **Compound knowledge:** LLM discovers patterns from trade history, writes rules, deprecates old ones — no human trading rules
- **Kelly criterion sizing:** Half-Kelly capped at 25%, math verified with unit tests
- **Graduated scaling:** 4-level position pyramid (1:1:2:4 ratio), stop-loss tightens per level
- **Self-discovery:** TG Agent uses explore_codebase to understand its own architecture, not hardcoded descriptions
