# Data Center — Intelligence Infrastructure

> The shared brain behind RIFI and TradeAgent.

---

## Connection Info

| Item | Value |
|------|-------|
| **Host** | enderzcxai.duckdns.org |
| **SSH** | `ssh -i Trade.pem ubuntu@enderzcxai.duckdns.org` |
| **SSH Key** | `E:\CC\服务器SSH密钥\Trade.pem` |
| **API Port** | 3200 (TradeAgent) |
| **Web Port** | 3000 (RIFI frontend) |
| **PM2 Process** | `rifi-vps` (TradeAgent), `rifi-web` (RIFI) |
| **Entry Point** | `/home/ubuntu/vps-api/vps/index.mjs` |
| **Database** | `/home/ubuntu/vps-api/data/rifi.db` (SQLite) |
| **OS** | Ubuntu, 5+ days uptime |

### Quick Commands

```bash
# SSH in
ssh -i "E:\CC\服务器SSH密钥\Trade.pem" ubuntu@enderzcxai.duckdns.org

# Check status
pm2 list

# View logs
pm2 logs rifi-vps --lines 30

# Restart
pm2 restart rifi-vps

# Deploy update
cd /home/ubuntu/vps-api
git clone --depth 1 https://github.com/enderzcx/RIFI.git /tmp/rifi-up
cp -r /tmp/rifi-up/vps/ ./vps/  # or from TradeAgent repo
rm -rf /tmp/rifi-up
pm2 restart rifi-vps
```

---

## Data Sources — Full Inventory

### 1. Crucix OSINT Engine (27 data keys)

Endpoint: `http://localhost:3117/api/data`

#### Markets (Real-time + History)

| Data | Symbol | Current | History | Used by Analyst? |
|------|--------|---------|---------|-----------------|
| S&P 500 | SPY | $650.34 | 5-day | Partial (sp500 only) |
| Nasdaq 100 | QQQ | $577.18 | 5-day | **NO** |
| Dow Jones | DIA | $463.19 | 5-day | **NO** |
| Russell 2000 | IWM | $248.00 | 5-day | **NO** |
| VIX | VIX | 25.25 | current | YES |
| Gold | GC=F | $4,701.70 | 4-day | YES |
| Silver | SI=F | $74.40 | 4-day | **NO** |
| WTI Crude | CL=F | $102.59 | 4-day | YES |
| Brent Crude | BZ=F | $104.81 | 4-day | **NO** |
| Natural Gas | NG=F | $2.89 | 4-day | YES |
| 20Y Treasury | TLT | $86.69 | current | **NO** |
| High Yield Bond | HYG | $79.56 | current | **NO** |
| IG Corporate | LQD | $108.99 | current | **NO** |
| Bitcoin | BTC-USD | $68,114 | current | YES |
| Ethereum | ETH-USD | $2,105 | current | YES |

#### Macro / Economic

| Key | Source | Data | Used? |
|-----|--------|------|-------|
| `fred` | Federal Reserve (FRED) | Interest rates, CPI, employment, GDP | **NO** |
| `treasury` | US Treasury | Government bond data | **NO** |
| `bls` | Bureau of Labor Statistics | Jobs, inflation, wages | **NO** |
| `gscpi` | NY Fed | Global Supply Chain Pressure Index | **NO** |
| `sdr` | IMF | Special Drawing Rights | **NO** |

#### Geopolitical / Security

| Key | Source | Data | Used? |
|-----|--------|------|-------|
| `acled` | Armed Conflict Location & Event Data | Conflict events + fatalities by region | YES (count only) |
| `gdelt` | Global Database of Events | Media-measured geopolitical tension | **NO** |
| `defense` | Defense intel | Military events | **NO** |
| `nuke` | Nuclear monitoring | Nuclear-related events | **NO** |
| `nukeSignals` | Nuclear alerts | Threat signals | **NO** |
| `chokepoints` | Maritime intel | Hormuz, Suez, Panama status | **NO** |
| `tg` | Telegram channels | Urgent breaking alerts | YES (urgent only) |
| `tSignals` | Threat aggregation | Combined threat signals | **NO** |

#### Environment / Science

| Key | Source | Data | Used? |
|-----|--------|------|-------|
| `noaa` | National Weather Service | Extreme weather alerts | **NO** |
| `epa` | Environmental Protection Agency | Environmental data | **NO** |
| `air` + `airMeta` | Air quality monitors | Air quality index | **NO** |
| `thermal` | Thermal monitoring | Temperature anomalies | **NO** |
| `space` | Space weather | Solar storms (affects comms/markets) | **NO** |
| `who` + `health` | World Health Organization | Disease outbreak alerts | **NO** |

#### Intelligence

| Key | Source | Data | Used? |
|-----|--------|------|-------|
| `news` + `newsFeed` | Aggregated news | Breaking news feed | Partially (via OpenNews) |
| `ideas` + `ideasSource` | TradingView-style | Analysis ideas | **NO** |
| `delta` | Crucix internal | Data change velocity since last check | **NO** |

### 2. OpenNews (6551.io)

Endpoint: `POST https://ai.6551.io/open/news_search`
Auth: `Bearer ${OPENNEWS_TOKEN}`

| Field | Description |
|-------|-------------|
| title | News headline |
| score | AI sentiment score (0-100) |
| signal | Direction: bullish / bearish / neutral |
| source | News source name |
| link | Article URL |

**Used by:** Analyst Agent (every 30min cycle)

### 3. OKX WebSocket (Real-time)

Connection: `wss://ws.okx.com:8443/ws/v5/public`

| Pair | Data | Frequency |
|------|------|-----------|
| BTC-USDT | Last price, bid, ask | Tick-level (sub-second) |
| ETH-USDT | Last price, bid, ask | Tick-level |
| SOL-USDT | Last price, bid, ask | Tick-level |

Derived data:
- 5-minute candle buffer → auto-saved to SQLite
- 5-minute high/low/change
- Price anomaly detection: 2% move → instant analysis, 5% move → FLASH alert

**Used by:** Analyst Agent (get_prices tool), anomaly trigger

### 4. Bitget CEX API

Base: `https://api.bitget.com`
Auth: HMAC-SHA256 signed requests

| Endpoint | Data |
|----------|------|
| `/api/v2/mix/market/tickers` | 540+ futures pairs (price, volume, change, funding rate) |
| `/api/v2/mix/market/candles` | 1H + 4H candlestick data (OHLCV) |
| `/api/v2/mix/market/open-interest` | Open Interest by symbol |
| `/api/v2/mix/market/ticker` | Single pair ticker + funding rate |
| `/api/v2/mix/account/accounts` | Account equity, available margin |
| `/api/v2/mix/position/all-position` | Open positions |
| `/api/v2/mix/order/orders-pending` | Unfilled limit orders |
| `/api/v2/mix/order/place-order` | Place new order |
| `/api/v2/mix/order/cancel-order` | Cancel order |
| `/api/v2/mix/order/place-tpsl-order` | Set TP/SL |
| `/api/v2/mix/account/set-leverage` | Set leverage per symbol |
| `/api/v2/spot/account/assets` | Spot balances |

**Used by:** Analyst (tech indicators), Scanner (opportunity detection), Executor (trade execution)

### 5. LiFi SDK

| Capability | Description |
|-----------|-------------|
| Quote | Get best route for cross-chain swap |
| Execute | Execute swap (Base ↔ ETH ↔ BSC, 60+ chains) |
| Token resolve | Map symbol → address per chain |

**Used by:** RIFI web (lifi_swap tool), potential TradeAgent cross-chain arb

### 6. Locally Computed Technical Indicators

All computed from Bitget candle data:

| Indicator | Parameters | Timeframes |
|-----------|-----------|------------|
| EMA | Period 20 | 1H, 4H |
| RSI | Period 7 (short), 14 (standard), Wilder's smoothing | 1H, 4H |
| MACD | 12/26/9 | 1H, 4H |
| ATR | Period 14 | 1H, 4H |
| Bollinger Bands | Period 20, 2σ | 1H, 4H |
| Fibonacci 0.31 | 50-bar swing range | 1H, 4H |
| Support / Resistance | 20-bar swing high/low | 1H, 4H |
| MA20, MA50 | Simple moving average | 1H |

---

## SQLite Database (11 tables)

Location: `/home/ubuntu/vps-api/data/rifi.db`

| Table | Records | Purpose |
|-------|---------|---------|
| `trades` | Trade history + PnL tracking |
| `decisions` | AI decision audit trail (every tool call) |
| `analysis` | Every 30min analysis result (JSON) |
| `news` | News archive (deduped by URL hash) |
| `candles` | 5min OHLCV from OKX WebSocket |
| `signal_scores` | Signal accuracy at 15m/1h/4h marks |
| `lessons` | AI-learned trading lessons (injected into prompts) |
| `source_scores` | Data source accuracy weighting |
| `strategies` | User-defined trading strategies |
| `patrol_reports` | 3-hour surveillance summaries |
| `agent_messages` | Inter-agent communication log |

---

## API Endpoints (29 routes)

Base: `http://localhost:3200`

### Data

| Method | Path | Returns |
|--------|------|---------|
| GET | `/api/signals?mode=crypto` | Latest analysis result |
| GET | `/api/analysis` | Both crypto + stock analysis |
| GET | `/api/prices` | Real-time BTC/ETH/SOL prices |
| GET | `/api/candles?pair=BTC-USDT` | 5min candle history |
| GET | `/api/health` | System health (LLM, Bitget, DB, WS) |
| GET | `/api/observability` | Agent metrics, cache state |

### Trades

| Method | Path | Returns |
|--------|------|---------|
| GET | `/api/trades?status=open` | Trade list |
| GET | `/api/trades/stats` | Win rate, PnL, drawdown |
| POST | `/api/trades` | Record new trade |
| POST | `/api/trades/:id/close` | Close trade with exit price |

### Decisions & Learning

| Method | Path | Returns |
|--------|------|---------|
| GET | `/api/decisions` | Decision history |
| POST | `/api/decisions` | Record decision |
| POST | `/api/decisions/batch` | Batch insert |
| GET | `/api/signal-accuracy` | Signal accuracy stats |
| GET | `/api/lessons` | Active AI lessons |

### Bitget Proxy

| Method | Path | Returns |
|--------|------|---------|
| GET | `/api/bitget/balance` | Spot + futures balance |
| GET | `/api/bitget/positions` | Open positions |
| GET | `/api/bitget/ticker?symbol=BTCUSDT` | Single ticker |
| POST | `/api/bitget/spot-order` | Place spot order |
| POST | `/api/bitget/futures-order` | Place futures order |

### Other

| Method | Path | Returns |
|--------|------|---------|
| POST | `/api/refresh` | Manually trigger analysis cycle |
| GET | `/api/history/news` | Recent news |
| GET | `/api/history/analysis` | Recent analyses |
| GET | `/api/history/patrol` | Patrol reports |
| GET/POST | `/api/strategies` | Strategy CRUD |
| POST | `/api/lifi-swap` | Cross-chain swap |
| GET | `/api/lifi-quote` | Swap quote |

---

## Usage Gap Analysis

**Currently used by Analyst: 7 out of 27 Crucix keys (~26%)**

Immediate expansion opportunities:
1. Add QQQ, DIA, IWM → complete US equity picture
2. Add TLT, HYG → bond market (risk-on/risk-off signal)
3. Add Silver, Brent → commodities breadth
4. Add `fred` → interest rate decisions, CPI
5. Add `gdelt` → geopolitical tension index
6. Add `chokepoints` → energy supply disruption (like the Openclaw Hormuz example)
7. Add `delta` → data velocity (what changed most = what matters most)
