# TradeAgent

Private autonomous AI trading agent. Not for public use.

## Architecture

```
7 AI Agents → Bitget CEX (540+ futures pairs)

Analyst (6 tools) → Risk (fail-closed) → Executor
       ↓
Scanner (RSI/EMA/MACD/ATR/BB/Fib0.31) → TechTrading
       ↓
Strategist → Reviewer (3h patrol + weekly)
```

## Run

```bash
cp .env.example .env  # fill in keys
npm install
npm start             # or: node index.mjs
```

## Structure

```
├── index.mjs           — entry point + wiring
├── config.mjs          — env + constants
├── db.mjs              — SQLite (11 tables)
├── llm.mjs             — LLM wrapper
├── pipeline.mjs        — main analysis loop (30min)
├── agents/             — 5 AI agents
├── bitget/             — CEX client + executor
├── market/             — prices, indicators, scanner
├── integrations/       — Crucix, OpenNews, LiFi, Telegram
└── routes/             — 29 API endpoints
```
