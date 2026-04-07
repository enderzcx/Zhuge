# 诸葛 (Zhuge) — Autonomous AI Trading System

7 AI agents, real money, self-evolving knowledge. Named after Zhuge Liang: observe, plan, act.

## What It Does

A multi-agent system that trades crypto futures 24/7 on Bitget. The TG Agent (诸葛) is the commander; 6 sub-agents (analyst, risk, researcher, strategist, reviewer, dream worker) run autonomously. A three-layer knowledge architecture lets the system learn from expert knowledge, its own experience, and real-time data — forming a closed-loop that validates and evolves knowledge over time.

~15,000 lines of code. 80+ files. 63 tests. 21 SQLite tables. One VPS.

## Architecture

```
Pipeline (AI-driven scheduling: analyst decides next_check_in)
  ├── Data Collection
  │     Crucix 27-source OSINT + OpenNews + OKX WebSocket
  │
  ├── Analyst Agent (9 tools, AI chooses which to call)
  │     submit_analysis → structured output (no free-form JSON parsing)
  │
  ├── Risk Agent (fail-closed)
  │     Hard rules: 24h loss >5% equity, consecutive losses → VETO
  │     Soft rules: LLM evaluation via submit_verdict tool
  │     Equity from WebSocket cache (zero-latency, no API call)
  │
  ├── Executor
  │     Kelly criterion sizing (half-Kelly, capped 25%)
  │     4-level graduated scaling (1:1:2:4 pyramid)
  │     Bitget Private WebSocket: real-time fills + position close
  │
  └── Strategist Agent (AI-generated strategy evaluation)

Scanner (540+ futures pairs)
  ├── Researcher Agent (momentum scoring: volume/price/funding/narrative)
  └── Auto open/close with TP/SL

Three-Layer Knowledge Architecture
  ├── Layer 1: Expert Knowledge (RAG)
  │     48+ entries: Wyckoff, SMC, ICT, Kelly, Fib 0.31, OI divergence...
  │     Local Ollama embedding + LanceDB vector search
  ├── Layer 2: Self-Discovered Knowledge (Compound)
  │     LLM reviews trades + vetoes + accuracy → generates rules
  │     Rules control execution params (leverage, TP/SL, margin)
  │     New strategies: proposed → backtest → active lifecycle
  └── Layer 3: Real-Time Intelligence
        Crucix OSINT + OKX prices + TG alerts + AI news

Memory System
  ├── Operational: context.md (what am I doing, what's next)
  ├── Long-term: notes/ with frontmatter metadata, keyword recall
  └── Dream Worker: every 6h, merge/prune/distill memories

Backtest Engine
  ├── Deterministic condition evaluator (conditions.mjs)
  ├── Pessimistic TP/SL order (check adverse direction first)
  ├── Same-candle re-entry guard (anti look-ahead bias)
  └── New strategies auto-backtest 14 days before activation

Observability
  ├── 19 metric types (SQLite time-series)
  ├── Structured JSON logging (31+ event types)
  ├── OpenTelemetry → Jaeger (3-layer span model)
  ├── Health alerts → Telegram
  └── TG Supergroup Dashboard (positions, PnL, news, system health)
```

## Event-Driven Execution

Trade lifecycle is event-driven via Bitget Private WebSocket, not polling:

```
Order placed → WS orders channel → fillPrice on fill → DB updated instantly
Position closed (TP/SL/liquidation) → WS positions channel → PnL calculated → reviewer triggered
Account balance change → WS account channel → equity cached → risk agent reads from cache

REST API sync runs every 30min as fallback (5min when WS is unhealthy).
```

## Tech Stack

- **Runtime:** Node.js (ESM), single VPS, PM2
- **Database:** SQLite (better-sqlite3), 21 tables, WAL mode
- **Knowledge:** LanceDB + Ollama (local embedding, nomic-embed-text)
- **LLM:** OpenAI-compatible API (per-agent model selection)
- **Exchange:** Bitget CEX (USDT-FUTURES), Private WebSocket for real-time events
- **Data:** Crucix OSINT (27 sources), OpenNews, OKX WebSocket
- **Tracing:** OpenTelemetry → Jaeger (OTLP HTTP)
- **Interface:** Telegram Bot (streaming, confirmation, supergroup dashboard)
- **Tests:** Vitest (63 cases: indicators, Kelly, scaling, signals, memory)

## Structure

```
├── index.mjs              — entry point, module wiring, AI-driven scheduling
├── pipeline.mjs           — main loop: collect → analyze → trade
├── config.mjs             — env config
├── db.mjs                 — SQLite schema (21 tables)
│
├── agent/                 — TG Agent harness
│   ├── llm.mjs            — LLM streaming + fallback
│   ├── loop.mjs           — async generator agent loop
│   ├── cognition/         — compound review + dream worker + conditions evaluator
│   ├── knowledge/         — Trading RAG (LanceDB + Ollama)
│   ├── memory/            — indexed recall with frontmatter metadata
│   ├── tools/             — 20+ tools (data, system, trade, memory, RAG)
│   ├── telegram/          — TG bot + streaming + confirmation
│   ├── push/              — smart push engine + TG dashboard
│   └── observe/           — metrics, logger, health, OTel tracing
│
├── agents/                — 6 autonomous sub-agents
│   ├── analyst.mjs        — 9-tool market analysis + submit_analysis
│   ├── risk.mjs           — fail-closed risk gate + submit_verdict
│   ├── researcher.mjs     — coin momentum scoring
│   ├── strategist.mjs     — strategy evaluation
│   ├── reviewer.mjs       — lesson extraction + signal accuracy
│   └── runner.mjs         — generic agent loop with tool calling
│
├── bitget/                — CEX integration
│   ├── client.mjs         — REST API + signing + rate-limit backoff
│   ├── ws.mjs             — Private WebSocket (orders/positions/account)
│   ├── executor.mjs       — Kelly sizing, 4-level scaling, WS event handlers
│   └── routes.mjs         — HTTP API
│
├── market/                — market data
│   ├── prices.mjs         — OKX WebSocket + anomaly detection
│   ├── scanner.mjs        — 540+ futures scanner
│   ├── indicators.mjs     — RSI, EMA, MACD, ATR, Bollinger, Fib (pure math)
│   └── signals.mjs        — signal accuracy tracking
│
├── backtest/              — deterministic backtest engine
│   ├── engine.mjs         — candle replay + condition evaluation
│   ├── simulator.mjs      — position management + PnL
│   ├── loader.mjs         — Bitget historical candle loading
│   └── report.mjs         — backtest result formatting
│
└── tests/                 — 63 unit tests (vitest)
```

## Key Design Decisions

- **Event-driven, not polling:** Bitget Private WebSocket for fills/positions/equity. REST as fallback only.
- **Structured LLM output:** Agents return results via function calls (submit_analysis, submit_verdict), not free-form JSON text.
- **AI-driven scheduling:** Analyst decides `next_check_in` (10min-4h) based on volatility.
- **Three-layer knowledge:** RAG (expert) + Compound (self-discovered) + Live (real-time), with feedback loop.
- **Fail-closed safety:** Risk agent VETOs when equity unknown. All trades require risk approval.
- **Kelly criterion sizing:** Half-Kelly capped at 25%, with 4-level graduated scaling.
- **Deterministic backtest:** No LLM in backtest loop — pure condition evaluation. Pessimistic TP/SL order prevents optimistic bias.
- **Strategy lifecycle:** proposed → backtest → active → retired. No LLM-generated strategy trades without surviving one compound review.
- **Memory hygiene:** Dream Worker (6h) merges/prunes/distills. Max 3 delete + 3 merge + 2 create per run to prevent hallucination-driven memory wipe.

## Setup

```bash
cp .env.example .env
# Fill in: Bitget API keys, LLM endpoint, Telegram bot token
npm install
node index.mjs
```

Requires:
- Node.js 20+
- Ollama running locally with `nomic-embed-text` model (for RAG)
- Bitget API key with futures trading permission
- OpenAI-compatible LLM endpoint
- (Optional) Telegram bot for dashboard + commands

## License

Private project. Source published for reference and portfolio purposes.
