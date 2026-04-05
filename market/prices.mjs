/**
 * OKX WebSocket price streaming, candle buffering, anomaly detection.
 */

import WebSocket from 'ws';

export function createPriceStream({ db, config, log, metrics }) {
  const _log = log || { info: console.log, warn: console.warn, error: console.error };
  const { insertCandle } = db;

  const PRICE_PAIRS = config.PRICE_PAIRS || ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'];
  const ANOMALY_THRESHOLD = 0.02;  // 2% in 5min → instant analysis
  const FLASH_THRESHOLD = 0.05;    // 5% in 5min → FLASH alert
  const PRICE_WINDOW = 5 * 60 * 1000; // 5 min

  let wsConnected = false;
  let wsReconnectTimer = null;
  let _anomalyHandler = null;

  // --- Price Cache ---
  const priceCache = {};
  function initPriceCache() {
    for (const pair of PRICE_PAIRS) {
      priceCache[pair] = { price: 0, ts: 0, change5m: 0, high5m: 0, low5m: 0, history: [] };
    }
  }
  initPriceCache();

  // --- Candle Buffer (5-min OHLCV) ---
  const CANDLE_INTERVAL = 5 * 60 * 1000; // 5 min
  const candleBuffer = {};

  function getCandleBucket(ts) {
    const d = new Date(ts);
    d.setSeconds(0, 0);
    d.setMinutes(Math.floor(d.getMinutes() / 5) * 5);
    return d.toISOString();
  }

  function flushCandle(pair) {
    const candle = candleBuffer[pair];
    if (!candle || !candle.open) return;
    try {
      insertCandle.run(pair, candle.open, candle.high, candle.low, candle.close, candle.ts_start);
    } catch {}
  }

  function updateCandle(pair, price, ts) {
    const bucket = getCandleBucket(ts);
    const existing = candleBuffer[pair];
    if (!existing || existing.ts_start !== bucket) {
      // New bucket — flush previous candle and start fresh
      if (existing) flushCandle(pair);
      candleBuffer[pair] = { open: price, high: price, low: price, close: price, ts_start: bucket };
    } else {
      existing.high = Math.max(existing.high, price);
      existing.low = Math.min(existing.low, price);
      existing.close = price;
    }
  }

  // Safety flush every 60s (handles low-activity periods)
  setInterval(() => {
    for (const pair of PRICE_PAIRS) {
      if (candleBuffer[pair]) flushCandle(pair);
    }
  }, 60000);

  function updatePrice(pair, price, ts) {
    const c = priceCache[pair];
    if (!c) return;
    c.price = price;
    c.ts = ts;
    c.history.push({ price, ts });

    // Trim history to 5min window
    const cutoff = ts - PRICE_WINDOW;
    while (c.history.length > 0 && c.history[0].ts < cutoff) c.history.shift();

    if (c.history.length > 1) {
      const oldest = c.history[0].price;
      c.change5m = (price - oldest) / oldest;
      c.high5m = Math.max(...c.history.map(h => h.price));
      c.low5m = Math.min(...c.history.map(h => h.price));
    }

    // Feed candle buffer
    updateCandle(pair, price, ts);
  }

  function checkPriceAnomaly(pair) {
    const c = priceCache[pair];
    if (!c || c.history.length < 2) return null;
    const absChange = Math.abs(c.change5m);
    if (absChange >= FLASH_THRESHOLD) return { pair, level: 'FLASH', change: c.change5m, price: c.price };
    if (absChange >= ANOMALY_THRESHOLD) return { pair, level: 'PRIORITY', change: c.change5m, price: c.price };
    return null;
  }

  // Cooldown: don't trigger analysis more than once per 3 min per pair
  const anomalyCooldowns = {};

  function handleAnomaly(anomaly) {
    const now = Date.now();
    const key = anomaly.pair;
    if (anomalyCooldowns[key] && now - anomalyCooldowns[key] < 3 * 60 * 1000) return;
    anomalyCooldowns[key] = now;

    const direction = anomaly.change > 0 ? 'up' : 'down';
    const pctStr = (anomaly.change * 100).toFixed(2);
    _log.info('price_anomaly', { module: 'prices', level: anomaly.level, pair: anomaly.pair, direction, changePct: pctStr, price: anomaly.price });
    metrics?.record('price_anomaly', Math.abs(anomaly.change) * 100, { pair: anomaly.pair, level: anomaly.level });

    // Trigger instant analysis via callback
    if (_anomalyHandler) {
      _anomalyHandler(anomaly);
    }
  }

  function connectOKXWebSocket() {
    const ws = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');

    ws.on('open', () => {
      wsConnected = true;
      _log.info('ws_connected', { module: 'prices', exchange: 'OKX' });
      // Subscribe to tickers
      ws.send(JSON.stringify({
        op: 'subscribe',
        args: PRICE_PAIRS.map(pair => ({ channel: 'tickers', instId: pair })),
      }));
    });

    ws.on('message', (raw) => {
      try {
        const text = raw.toString();
        if (text === 'pong') return; // OKX ping/pong heartbeat, not JSON
        const msg = JSON.parse(text);
        if (msg.data && Array.isArray(msg.data)) {
          for (const tick of msg.data) {
            const pair = tick.instId;
            const price = parseFloat(tick.last);
            const ts = parseInt(tick.ts) || Date.now();
            if (pair && price > 0) {
              updatePrice(pair, price, ts);
              const anomaly = checkPriceAnomaly(pair);
              if (anomaly) handleAnomaly(anomaly);
            }
          }
        }
      } catch (e) { _log.error('ws_parse_error', { module: 'prices', error: e.message }); }
    });

    ws.on('close', () => {
      wsConnected = false;
      _log.warn('ws_disconnected', { module: 'prices', exchange: 'OKX' });
      metrics?.record('ws_disconnect', 1, { exchange: 'OKX' });
      wsReconnectTimer = setTimeout(connectOKXWebSocket, 5000);
    });

    ws.on('error', (err) => {
      _log.error('ws_error', { module: 'prices', exchange: 'OKX', error: err.message });
      metrics?.record('ws_error', 1, { exchange: 'OKX' });
      ws.close();
    });

    // Ping every 25s to keep alive
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send('ping');
      else clearInterval(pingInterval);
    }, 25000);
  }

  function setAnomalyHandler(fn) {
    _anomalyHandler = fn;
  }

  function getPriceData() {
    const prices = {};
    for (const pair of PRICE_PAIRS) {
      const c = priceCache[pair];
      prices[pair] = { price: c.price, change5m: (c.change5m * 100).toFixed(2) + '%', high5m: c.high5m, low5m: c.low5m };
    }
    return prices;
  }

  return {
    priceCache,
    connectOKXWebSocket,
    getPriceData,
    setAnomalyHandler,
    getCandleBucket,
    get wsConnected() { return wsConnected; },
  };
}
