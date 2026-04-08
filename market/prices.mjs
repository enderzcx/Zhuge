/**
 * Price cache, candle buffering, anomaly detection.
 * Tick data is fed externally via feedTick() — from Bitget public WS (via kline-monitor).
 * No longer connects to OKX WebSocket directly.
 */

export function createPriceStream({ db, config, log, metrics }) {
  const _log = log || { info: console.log, warn: console.warn, error: console.error };
  const { insertCandle } = db;

  const PRICE_PAIRS = config.PRICE_PAIRS || ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'];
  const ANOMALY_THRESHOLD = 0.02;  // 2% in 5min → instant analysis
  const FLASH_THRESHOLD = 0.05;    // 5% in 5min → FLASH alert
  const PRICE_WINDOW = 5 * 60 * 1000; // 5 min

  let _connected = false;
  let _anomalyHandler = null;
  let _onCandleClose = null;

  // --- Price Cache ---
  const priceCache = {};
  function initPriceCache() {
    for (const pair of PRICE_PAIRS) {
      priceCache[pair] = { price: 0, ts: 0, change5m: 0, high5m: 0, low5m: 0, history: [] };
    }
  }
  initPriceCache();

  // --- Candle Buffer (5-min OHLCV from ticks) ---
  const candleBuffer = {};

  function getCandleBucket(ts) {
    const d = new Date(ts);
    d.setSeconds(0, 0);
    d.setMinutes(Math.floor(d.getMinutes() / 5) * 5);
    return d.toISOString();
  }

  function flushCandle(pair, isBucketTransition = false) {
    const candle = candleBuffer[pair];
    if (!candle || !candle.open) return;
    try {
      insertCandle.run(pair, candle.open, candle.high, candle.low, candle.close, candle.ts_start);
    } catch (e) { _log.warn('candle_insert_failed', { module: 'prices', pair, error: e.message }); }
    if (isBucketTransition && _onCandleClose) {
      try { _onCandleClose(pair, { ...candle }); } catch {}
    }
  }

  function updateCandle(pair, price, ts) {
    const bucket = getCandleBucket(ts);
    const existing = candleBuffer[pair];
    if (!existing || existing.ts_start !== bucket) {
      if (existing) flushCandle(pair, true);
      candleBuffer[pair] = { open: price, high: price, low: price, close: price, ts_start: bucket };
    } else {
      existing.high = Math.max(existing.high, price);
      existing.low = Math.min(existing.low, price);
      existing.close = price;
    }
  }

  // Safety flush every 60s
  setInterval(() => {
    for (const pair of Object.keys(candleBuffer)) {
      if (candleBuffer[pair]) flushCandle(pair);
    }
  }, 60000);

  function updatePrice(pair, price, ts) {
    // Auto-init priceCache for dynamically subscribed pairs
    if (!priceCache[pair]) {
      priceCache[pair] = { price: 0, ts: 0, change5m: 0, high5m: 0, low5m: 0, history: [] };
    }
    const c = priceCache[pair];
    c.price = price;
    c.ts = ts;
    c.history.push({ price, ts });

    const cutoff = ts - PRICE_WINDOW;
    while (c.history.length > 0 && c.history[0].ts < cutoff) c.history.shift();

    if (c.history.length > 1) {
      const oldest = c.history[0].price;
      c.change5m = (price - oldest) / oldest;
      c.high5m = Math.max(...c.history.map(h => h.price));
      c.low5m = Math.min(...c.history.map(h => h.price));
    }

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

    if (_anomalyHandler) {
      _anomalyHandler(anomaly);
    }
  }

  /**
   * Feed a tick from external source (Bitget WS via kline-monitor).
   * This replaces the old OKX WebSocket connection.
   */
  function feedTick(pair, price, ts) {
    _connected = true;
    updatePrice(pair, price, ts);
    const anomaly = checkPriceAnomaly(pair);
    if (anomaly) handleAnomaly(anomaly);
  }

  function setAnomalyHandler(fn) {
    _anomalyHandler = fn;
  }

  function setOnCandleClose(fn) {
    _onCandleClose = fn;
  }

  function getPriceData() {
    const prices = {};
    for (const pair of Object.keys(priceCache)) {
      const c = priceCache[pair];
      if (c.price > 0) {
        prices[pair] = { price: c.price, change5m: (c.change5m * 100).toFixed(2) + '%', high5m: c.high5m, low5m: c.low5m };
      }
    }
    return prices;
  }

  return {
    priceCache,
    feedTick,
    getPriceData,
    setAnomalyHandler,
    setOnCandleClose,
    getCandleBucket,
    get candleBuffer() { return candleBuffer; },
    get wsConnected() { return _connected; },
  };
}
