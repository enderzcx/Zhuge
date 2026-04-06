# 诸葛 (Zhuge) — TradeAgent

Autonomous AI trading system — 7 agents, real money, self-learning. Named after Zhuge Liang: observe, plan, act.

## What It Does

A multi-agent system that trades crypto futures 24/7 on Bitget CEX. 诸葛 (TG Agent) is the commander; 5 sub-agents (analyst, risk, researcher, strategist, reviewer) run autonomously. A three-layer knowledge architecture lets the system learn from expert knowledge, its own experience, and real-time data — forming a closed-loop that validates and evolves knowledge over time.

## Architecture

```
诸葛 TG Agent (commander, natural language interface, self-discovery)
  │
  ├── Pipeline (AI-driven scheduling: analyst decides next_check_in)
  │     ├── Data Collection (Crucix 27-source OSINT + OpenNews + OKX WebSocket)
  │     ├── Analyst Agent (7 tools, AI chooses which to call)
  │     │     ├── get_crucix_data, get_crypto_news, get_prices (baseline)
  │     │     ├── get_technical_indicators (conditional: only for serious candidates)
  │     │     ├── search_knowledge (RAG: cross-reference patterns with 48+ entries)
  │     │     └── get_system_metrics (self-calibrate: accuracy, veto rate)
  │     ├── Risk Agent (fail-closed: 24h loss >5%, 3 consecutive losses → VETO)
  │     ├── Executor (Kelly sizing, 4-level graduated scaling, TP/SL)
  │     └── Strategist Agent (strategy evaluation)
  │
  ├── Scanner (AI-driven scheduling)
  │     ├── 540+ futures market scan
  │     ├── Researcher Agent (volume/price action/funding/narrative scoring)
  │     └── Momentum trading (auto open/close)
  │
  ├── Three-Layer Knowledge Architecture
  │     ├── Layer 1: Expert Knowledge (RAG)
  │     │     48 entries: Wyckoff/SMC/ICT/Kelly/0.31 Fib/OI divergence...
  │     │     Local Ollama embedding + LanceDB vector search, 110ms, zero API cost
  │     ├── Layer 2: Self-Discovered Knowledge (Compound)
  │     │     LLM reviews trade history + veto patterns + signal accuracy
  │     │     → auto-generates rules with confidence + evidence
  │     │     → validates/updates/deprecates on each review cycle
  │     └── Layer 3: Real-Time Intelligence
  │           Crucix 27-source OSINT + OKX prices + TG alerts + AI news
  │     Feedback loop: Layer 1 → influences trades → results feed Layer 2
  │     → Layer 2 validates Layer 1 knowledge effectiveness → evolves
  │
  ├── Compound System Review (every 10 trades or 10+ vetoes)
  │     ├── Trade patterns (win/loss analysis)
  │     ├── Decision flow (veto rationality, threshold tuning)
  │     ├── Signal calibration (accuracy trends, directional bias)
  │     ├── Momentum efficiency (scanner conversion rate)
  │     └── System-level optimization suggestions
  │
  ├── Reviewer Agent (every 3h)
  │     ├── Signal accuracy scoring
  │     └── Lesson extraction
  │
  └── Observability
        ├── 19 metric types (SQLite time-series)
        ├── Structured JSON logging (31+ event types, zero bare console.log)
        ├── OpenTelemetry → Jaeger (3-layer span model)
        ├── Health alerts → TG (RSS/mem/event loop thresholds)
        └── Self-discovery tools (explore_codebase, query_metrics, read_logs)
```

## Tech Stack

- **Runtime:** Node.js (ESM), single VPS, PM2
- **Database:** SQLite (better-sqlite3), 19 tables, WAL mode
- **Knowledge:** LanceDB (embedded vector DB) + Ollama (local embedding, nomic-embed-text)
- **LLM:** OpenAI-compatible API (gpt-5.4-mini default, per-agent model selection)
- **Exchange:** Bitget CEX (futures + spot)
- **Data:** Crucix OSINT (27 sources), OpenNews, OKX WebSocket, Telegram channels
- **Tracing:** OpenTelemetry → Jaeger (OTLP HTTP)
- **Interface:** Telegram Bot (streaming, inline confirmation, supergroup dashboard)
- **Tests:** Vitest (60 cases: indicators, Kelly, scaling, signals)

## Structure

```
├── index.mjs              — entry point, module wiring, AI-driven scheduling, graceful shutdown
├── pipeline.mjs           — main loop: collect → analyze → trade (AI decides interval)
├── config.mjs             — env config (dotenv)
├── db.mjs                 — SQLite schema (19 tables, single source of truth)
│
├── agent/                 — 诸葛 TG Agent harness
│   ├── llm.mjs            — LLM streaming + fallback
│   ├── loop.mjs           — async generator agent loop (8 round max)
│   ├── history.mjs        — conversation history + 3-layer compression
│   ├── model-select.mjs   — per-conversation model selection + latch
│   ├── tools/             — 20+ tools (data, system, trade, memory, RAG)
│   ├── telegram/          — TG bot + streaming + confirmation keyboards
│   ├── prompts/           — system prompt assembly (static + dynamic injection)
│   ├── cognition/         — compound knowledge + decision provenance
│   ├── knowledge/         — Trading RAG (LanceDB + Ollama embedding)
│   ├── push/              — smart push (FLASH/TRADE/ERROR) + TG dashboard
│   ├── observe/           — metrics, logger, health monitor, OTel tracing
│   └── memory/            — agent memory files (context, directives)
│
├── agents/                — 5 autonomous sub-agents
│   ├── analyst.mjs        — 7-tool market analysis (AI chooses tools per cycle)
│   ├── risk.mjs           — fail-closed risk gate (hard rules + LLM soft check)
│   ├── researcher.mjs     — new coin momentum scoring (4 dimensions)
│   ├── strategist.mjs     — active strategy evaluation
│   └── reviewer.mjs       — post-trade lesson extraction + signal accuracy
│
├── bitget/                — CEX integration
│   ├── client.mjs         — authenticated API + latency metrics + OTel spans
│   ├── executor.mjs       — Kelly sizing, 4-level scaling, trade sync
│   └── routes.mjs         — HTTP API for manual orders
│
├── market/                — market data
│   ├── prices.mjs         — OKX WebSocket + anomaly detection (event-driven interrupt)
│   ├── scanner.mjs        — 540+ futures scanner + momentum pipeline
│   ├── indicators.mjs     — RSI, EMA, MACD, ATR, Bollinger, Fib (pure math, tested)
│   └── signals.mjs        — historical signal accuracy tracking
│
├── data/
│   ├── rifi.db            — SQLite database (19 tables)
│   ├── knowledge/         — LanceDB vector store (48+ entries)
│   ├── logs/              — structured JSON logs (7-day rolling)
│   └── seed-knowledge.json — seed data for RAG
│
└── tests/                 — unit tests (vitest, 60 cases)
    ├── indicators.test.mjs
    ├── scaling.test.mjs
    └── signals.test.mjs
```

## Key Design Decisions

- **AI-driven scheduling:** Analyst decides `next_check_in` (10min-4h) based on market conditions, not fixed cron
- **Three-layer knowledge:** RAG (expert) + Compound (self-discovered) + Live (real-time), with feedback loop
- **Prompts as control plane:** Agent behavior defined in .md files, not hardcoded if/else
- **Fail-closed safety:** All dangerous operations require TG confirmation. Unknown tools blocked by default
- **Compound system review:** Reviews entire decision pipeline (trades + vetoes + accuracy + efficiency), not just trade outcomes
- **Self-discovery:** 诸葛 uses explore_codebase to understand its own architecture, not hardcoded descriptions
- **Kelly criterion sizing:** Half-Kelly capped at 25%, dynamic leverage from config/compound, math verified with tests
- **Graduated scaling:** 4-level position pyramid (1:1:2:4 ratio), stop-loss tightens per level
- **Zero external dependencies for observability:** SQLite metrics + JSON logs + LanceDB vectors, all on one VPS

## Roadmap

### Completed
- [x] Phase 1: AI-driven analysis scheduling (analyst outputs next_check_in)
- [x] Phase 2: Analyst chooses tools (7 tools, AI decides which to call per cycle)
- [x] Trading-Specific RAG (48 entries, local Ollama + LanceDB)
- [x] Compound reviews entire system (trades + vetoes + accuracy + momentum funnel)
- [x] Full observability (19 metrics, structured logging, OTel → Jaeger, health alerts)
- [x] Fund safety overhaul (dynamic leverage, Kelly, graceful shutdown, risk includes floating PnL)
- [x] 60 unit tests (indicators, Kelly, scaling, signals)

### Next
- [ ] Phase 3: AI generates trading strategies (not just avoid/prefer rules, but full strategy logic)
- [ ] Compound confidence → RAG feedback (validate expert knowledge against live results)
- [ ] Multi-timeframe analysis (analyst chooses timeframe, not hardcoded 1H/4H)
- [ ] Agent-to-agent communication (analyst can ask researcher for specific coin analysis)
- [ ] Backtest framework (replay historical data through current rules + knowledge)
