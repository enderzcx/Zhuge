/**
 * Real-time K-line monitor — Bitget public WebSocket kline subscriptions
 * + indicator computation + signal detection.
 *
 * Architecture:
 *   - Bitget public WS: subscribe to 5m candle channel per symbol
 *   - On candle close: compute indicators, detect signals, trigger pipeline
 *   - Snapshot every 60s: compute on live (unclosed) candle for early warnings
 *   - Multi-timeframe: aggregate 5m → 15m → 1h in memory
 *   - Dynamic subscribe/unsubscribe via agent tools
 *
 * Also listens to OKX candle close callback for base pairs (BTC/ETH/SOL)
 * as a fallback data source.
 */

import WebSocket from 'ws';
import { computeIndicators } from './indicators.mjs';

export function createKlineMonitor({ db, priceStream, pipeline, messageBus, config, log, metrics, pushEngine }) {
  const _log = log || { info() {}, warn() {}, error() {} };
  const _m = metrics || { record() {} };
  const CONF = config.KLINE_MONITOR || {};
  const DISABLED_API = { start() {}, stop() {}, onCandleClose() {}, getIndicators() { return null; }, subscribe() { return { error: 'disabled' }; }, unsubscribe() { return { error: 'disabled' }; }, getStatus() { return []; } };
  if (!CONF.enabled) return DISABLED_API;

  const basePairs = config.PRICE_PAIRS || ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'];
  const activePairs = new Set(basePairs);
  const SNAPSHOT_MS = CONF.snapshot_interval_ms || 60_000;
  const SIGNAL_COOLDOWN = CONF.signal_cooldown_ms || 60_000;
  const ALERT_COOLDOWN = CONF.alert_cooldown_ms || 300_000;
  const HISTORY = CONF.history_candles || 200;
  const SIG = CONF.signals || {};

  let snapshotTimer = null;
  let lastSignalTime = 0;
  let _initializing = true;  // suppress signals during history seed
  const alertCooldowns = {};

  // --- Per-symbol indicator cache ---
  const indicatorCache = {};

  // --- In-memory candle arrays ---
  const candleArrays = {};

  // --- Bitget Public WebSocket ---
  const BITGET_PUBLIC_WS = 'wss://ws.bitget.com/v2/ws/public';
  let _ws = null;
  let _wsConnected = false;
  let _reconnectTimer = null;
  let _reconnectAttempts = 0;
  let _pingInterval = null;
  // Track which pairs are subscribed on WS (to avoid re-subscribing)
  const wsSubscribed = new Set();
  // Track last candle ts per pair to detect close
  const lastCandleTs = {};

  function initPair(pair) {
    if (candleArrays[pair]) return;
    candleArrays[pair] = { '5m': [], '15m': [], '1h': [] };
    indicatorCache[pair] = {};
  }

  // --- Load historical 5m candles from DB ---
  function loadHistory(pair) {
    initPair(pair);
    try {
      const rows = db.db.prepare(
        'SELECT open, high, low, close, ts_start FROM candles WHERE pair = ? ORDER BY ts_start DESC LIMIT ?'
      ).all(pair, HISTORY);
      candleArrays[pair]['5m'] = rows.reverse().map(r => ({
        o: r.open, h: r.high, l: r.low, c: r.close, ts: r.ts_start,
      }));
      candleArrays[pair]['15m'] = aggregateCandles(candleArrays[pair]['5m'], 3);
      candleArrays[pair]['1h'] = aggregateCandles(candleArrays[pair]['5m'], 12);
      _log.info('kline_history_loaded', { module: 'kline', pair, candles_5m: candleArrays[pair]['5m'].length });
    } catch (e) {
      _log.error('kline_history_load_failed', { module: 'kline', pair, error: e.message });
    }
  }

  // --- Seed from Bitget REST API (for pairs without DB history) ---
  async function seedFromBitget(pair) {
    const symbol = pair.replace('-', '');
    const url = `https://api.bitget.com/api/v2/mix/market/candles?productType=USDT-FUTURES&symbol=${symbol}&granularity=5m&limit=200`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Bitget ${res.status}`);
    const data = await res.json();
    const candles = data?.data || [];
    if (!candles.length) return;

    const sorted = [...candles].reverse(); // oldest first
    initPair(pair);
    for (const c of sorted) {
      const ts = new Date(parseInt(c[0])).toISOString();
      const o = parseFloat(c[1]), h = parseFloat(c[2]), l = parseFloat(c[3]), cl = parseFloat(c[4]);
      const vol = parseFloat(c[5]) || 0;
      try { db.insertCandle.run(pair, o, h, l, cl, ts); } catch {}
      candleArrays[pair]['5m'].push({ o, h, l, c: cl, v: vol, ts });
    }
    if (candleArrays[pair]['5m'].length > HISTORY) {
      candleArrays[pair]['5m'] = candleArrays[pair]['5m'].slice(-HISTORY);
    }
    candleArrays[pair]['15m'] = aggregateCandles(candleArrays[pair]['5m'], 3);
    candleArrays[pair]['1h'] = aggregateCandles(candleArrays[pair]['5m'], 12);
    computeForPair(pair, '5m');
    computeForPair(pair, '15m');
    computeForPair(pair, '1h');
    _log.info('kline_seeded', { module: 'kline', pair, candles: candleArrays[pair]['5m'].length });
  }

  // =====================================================
  // Bitget Public WebSocket — kline channel
  // =====================================================

  function connectBitgetWS() {
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }

    try { _ws = new WebSocket(BITGET_PUBLIC_WS); } catch (e) {
      _log.error('kline_ws_create_failed', { module: 'kline', error: e.message });
      _scheduleReconnect();
      return;
    }

    _ws.on('open', () => {
      _wsConnected = true;
      _reconnectAttempts = 0;
      _log.info('kline_ws_connected', { module: 'kline' });
      // Re-subscribe all active pairs
      wsSubscribed.clear();
      for (const pair of activePairs) _wsSubscribe(pair);
    });

    _ws.on('message', (raw) => {
      try {
        const text = raw.toString();
        if (text === 'pong') return;
        const msg = JSON.parse(text);
        if (msg.event === 'subscribe') return;
        if (msg.data && msg.arg?.channel) {
          if (msg.arg.channel.startsWith('candle')) _handleKlineData(msg);
          else if (msg.arg.channel === 'ticker') _handleTickerData(msg);
        }
      } catch (e) {
        _log.error('kline_ws_parse_error', { module: 'kline', error: e.message });
      }
    });

    _ws.on('close', () => {
      _wsConnected = false;
      if (_pingInterval) { clearInterval(_pingInterval); _pingInterval = null; }
      _log.warn('kline_ws_disconnected', { module: 'kline' });
      wsSubscribed.clear();
      _scheduleReconnect();
    });

    _ws.on('error', (err) => {
      _log.error('kline_ws_error', { module: 'kline', error: err.message });
      _ws.close();
    });

    _pingInterval = setInterval(() => {
      if (_ws?.readyState === WebSocket.OPEN) _ws.send('ping');
      else { clearInterval(_pingInterval); _pingInterval = null; }
    }, 25000);
  }

  function _scheduleReconnect() {
    _reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, _reconnectAttempts), 60000);
    _reconnectTimer = setTimeout(connectBitgetWS, delay);
  }

  function _wsSubscribe(pair) {
    if (wsSubscribed.has(pair) || !_wsConnected) return;
    const instId = pair.replace('-', '');
    // Subscribe to both candle5m (K-line) and ticker (real-time price) channels
    _ws.send(JSON.stringify({
      op: 'subscribe',
      args: [
        { instType: 'USDT-FUTURES', channel: 'candle5m', instId },
        { instType: 'USDT-FUTURES', channel: 'ticker', instId },
      ],
    }));
    wsSubscribed.add(pair);
  }

  function _wsUnsubscribe(pair) {
    if (!wsSubscribed.has(pair) || !_wsConnected) return;
    const instId = pair.replace('-', '');
    _ws.send(JSON.stringify({
      op: 'unsubscribe',
      args: [
        { instType: 'USDT-FUTURES', channel: 'candle5m', instId },
        { instType: 'USDT-FUTURES', channel: 'ticker', instId },
      ],
    }));
    wsSubscribed.delete(pair);
  }

  /**
   * Handle incoming ticker data from Bitget WS.
   * Feed real-time price to priceStream for anomaly detection + price cache.
   * Bitget ticker: { instId, lastPr, ts, ... }
   */
  function _handleTickerData(msg) {
    for (const tick of msg.data) {
      const instId = tick.instId || msg.arg?.instId;
      if (!instId) continue;
      const pair = instId.replace('USDT', '-USDT');
      const price = parseFloat(tick.lastPr || tick.last || '0');
      const ts = parseInt(tick.ts) || Date.now();
      if (price > 0) {
        priceStream.feedTick(pair, price, ts);
      }
    }
  }

  /**
   * Handle incoming kline data from Bitget WS.
   * Bitget candle format: [ts, open, high, low, close, vol, quoteVol]
   * The last candle in data[] is the current (unclosed) candle.
   * When ts changes from previous push → previous candle has closed.
   */
  function _handleKlineData(msg) {
    const instId = msg.arg?.instId;
    if (!instId) return;
    // Convert back to our pair format: BTCUSDT → BTC-USDT
    const pair = instId.replace('USDT', '-USDT');
    if (!activePairs.has(pair)) return;

    for (const candle of msg.data) {
      const ts = new Date(parseInt(candle[0])).toISOString();
      const o = parseFloat(candle[1]), h = parseFloat(candle[2]);
      const l = parseFloat(candle[3]), c = parseFloat(candle[4]);
      const v = parseFloat(candle[5]) || 0;

      const prevTs = lastCandleTs[pair];
      lastCandleTs[pair] = ts;

      if (prevTs && prevTs !== ts) {
        // Timestamp changed → previous candle closed, this is a new candle
        // The previous candle's final values are in our candleArrays (updated on prior pushes)
        // Trigger candle close processing
        _onCandleFinalized(pair);
      }

      // Update or append current candle in memory
      initPair(pair);
      const arr = candleArrays[pair]['5m'];
      if (arr.length > 0 && arr[arr.length - 1].ts === ts) {
        // Update existing (unclosed) candle
        const last = arr[arr.length - 1];
        last.h = h; last.l = l; last.c = c; last.v = v;
      } else {
        // New candle
        arr.push({ o, h, l, c, v, ts });
        if (arr.length > HISTORY) arr.shift();
      }

      // Persist to DB (upsert)
      try { db.insertCandle.run(pair, o, h, l, c, ts); } catch {}
    }
  }

  // =====================================================
  // Candle close processing (shared by Bitget WS + OKX fallback)
  // =====================================================

  function _onCandleFinalized(pair) {
    const arr5m = candleArrays[pair]?.['5m'];
    if (!arr5m || arr5m.length < 20) return;

    // Re-aggregate higher timeframes
    candleArrays[pair]['15m'] = aggregateCandles(arr5m, 3);
    candleArrays[pair]['1h'] = aggregateCandles(arr5m, 12);

    // Compute indicators
    const prev5m = indicatorCache[pair]?.['5m'] || null;
    const ind5m = computeForPair(pair, '5m');
    computeForPair(pair, '15m');
    computeForPair(pair, '1h');

    if (!ind5m) return;

    // Detect signals (skip during initialization to avoid history false positives)
    if (_initializing) return;
    const signals = detectSignals(pair, ind5m, prev5m);
    if (signals.length > 0) {
      _log.info('kline_signal', { module: 'kline', pair, signals: signals.map(s => s.detail) });
      _m.record('kline_signal_count', signals.length, { pair });
      messageBus?.postMessage?.('kline-monitor', 'analyst', 'KLINE_SIGNAL', { pair, signals, indicators: ind5m });

      const now = Date.now();
      if (now - lastSignalTime > SIGNAL_COOLDOWN) {
        lastSignalTime = now;
        // Trigger full pipeline analysis — analyst will see the signal via kline context in prompt
        _log.info('kline_trigger_pipeline', { module: 'kline', pair, signals: signals.length });
        pipeline?.collectAndAnalyze?.().catch(e =>
          _log.error('kline_pipeline_trigger_error', { module: 'kline', error: e.message })
        );
      }
    }

    const last = arr5m[arr5m.length - 1];
    _log.info('kline_close', { module: 'kline', pair, close: last?.c, ema20: ind5m.ema20?.toFixed(2), rsi14: ind5m.rsi14?.toFixed(1), macd_cross: ind5m.macd_cross });
  }

  /**
   * OKX candle close fallback — called by prices.mjs for base pairs.
   * If Bitget WS is handling this pair, skip (avoid double processing).
   */
  function onCandleClose(pair, candle) {
    if (wsSubscribed.has(pair)) return; // Bitget WS handles it
    initPair(pair);
    const arr5m = candleArrays[pair]['5m'];
    arr5m.push({ o: candle.open, h: candle.high, l: candle.low, c: candle.close, v: 0, ts: candle.ts_start });
    if (arr5m.length > HISTORY) arr5m.shift();
    _onCandleFinalized(pair);
  }

  // =====================================================
  // Indicator computation + signal detection
  // =====================================================

  function aggregateCandles(candles, factor) {
    const result = [];
    for (let i = 0; i + factor <= candles.length; i += factor) {
      const chunk = candles.slice(i, i + factor);
      result.push({
        o: chunk[0].o,
        h: Math.max(...chunk.map(c => c.h)),
        l: Math.min(...chunk.map(c => c.l)),
        c: chunk[chunk.length - 1].c,
        v: chunk.reduce((s, c) => s + (c.v || 0), 0),
        ts: chunk[0].ts,
      });
    }
    return result;
  }

  function toIndicatorData(candles) {
    return {
      closes: candles.map(c => c.c),
      highs: candles.map(c => c.h),
      lows: candles.map(c => c.l),
      opens: candles.map(c => c.o),
      volumes: candles.map(c => c.v || 0),
    };
  }

  function computeForPair(pair, timeframe) {
    const candles = candleArrays[pair]?.[timeframe];
    if (!candles || candles.length < 20) return null;
    try {
      const data = toIndicatorData(candles);
      const result = computeIndicators(data, timeframe);
      if (!indicatorCache[pair]) indicatorCache[pair] = {};
      indicatorCache[pair][timeframe] = { ...result, computed_at: new Date().toISOString() };
      return result;
    } catch (e) {
      _log.error('kline_compute_error', { module: 'kline', pair, timeframe, error: e.message });
      return null;
    }
  }

  function detectSignals(pair, indicators, prevIndicators) {
    if (!indicators || indicators.error) return [];
    const signals = [];

    // EMA9/21 cross
    if (SIG.ema_cross && indicators.ma_cross) {
      const mc = indicators.ma_cross;
      if (mc.ema9_cross_ema21 === 'GOLDEN_CROSS') signals.push({ type: 'ema_cross', direction: 'bullish', detail: 'EMA9/21 golden cross' });
      if (mc.ema9_cross_ema21 === 'DEATH_CROSS') signals.push({ type: 'ema_cross', direction: 'bearish', detail: 'EMA9/21 death cross' });
    }

    // MACD cross
    if (SIG.macd_cross && indicators.macd_cross) {
      if (indicators.macd_cross === 'BULLISH_CROSS') signals.push({ type: 'macd_cross', direction: 'bullish', detail: 'MACD bullish cross' });
      if (indicators.macd_cross === 'BEARISH_CROSS') signals.push({ type: 'macd_cross', direction: 'bearish', detail: 'MACD bearish cross' });
    }

    // RSI extreme
    if (SIG.rsi_extreme) {
      const ob = SIG.rsi_extreme.overbought || 75;
      const os = SIG.rsi_extreme.oversold || 25;
      if (indicators.rsi14 <= os) signals.push({ type: 'rsi_extreme', direction: 'bullish', detail: `RSI14 oversold: ${indicators.rsi14?.toFixed(1)}` });
      if (indicators.rsi14 >= ob) signals.push({ type: 'rsi_extreme', direction: 'bearish', detail: `RSI14 overbought: ${indicators.rsi14?.toFixed(1)}` });
    }

    // BB squeeze
    if (SIG.bb_squeeze_threshold && indicators.bollinger) {
      const bb = indicators.bollinger;
      if (bb.bandwidth && bb.bandwidth < SIG.bb_squeeze_threshold) {
        signals.push({ type: 'bb_squeeze', direction: 'neutral', detail: `BB squeeze: width ${(bb.bandwidth * 100).toFixed(2)}%` });
      }
    }

    // BB breakout
    if (indicators.bb_position === 'ABOVE_UPPER') signals.push({ type: 'bb_breakout', direction: 'bullish', detail: 'Price above BB upper' });
    if (indicators.bb_position === 'BELOW_LOWER') signals.push({ type: 'bb_breakout', direction: 'bearish', detail: 'Price below BB lower' });

    // Volume breakout: current candle volume > 2.5x average volume
    const volSpike = SIG.volume_spike || 2.5;
    const candles = candleArrays[pair]?.['5m'];
    if (candles && candles.length >= 20) {
      const recentVols = candles.slice(-21, -1).map(c => c.v || 0);
      const avgVol = recentVols.reduce((s, v) => s + v, 0) / recentVols.length;
      const currentVol = candles[candles.length - 1]?.v || 0;
      if (avgVol > 0 && currentVol > avgVol * volSpike) {
        const priceChange = indicators.price && indicators.ema20
          ? ((indicators.price - indicators.ema20) / indicators.ema20 * 100).toFixed(2)
          : '?';
        const dir = indicators.price > indicators.ema20 ? 'bullish' : 'bearish';
        signals.push({
          type: 'volume_breakout',
          direction: dir,
          detail: `Volume spike ${(currentVol / avgVol).toFixed(1)}x avg, price ${priceChange}% vs EMA20`,
        });
      }
    }

    return signals;
  }

  // =====================================================
  // Snapshot: periodic check on live candle
  // =====================================================

  function runSnapshot() {
    for (const pair of activePairs) {
      const arr = candleArrays[pair]?.['5m'];
      if (!arr?.length) continue;

      // For Bitget WS pairs, the last candle in array IS the live candle (continuously updated)
      // For OKX pairs, use the candle buffer from priceStream
      let tentative;
      if (wsSubscribed.has(pair)) {
        // Last element is already the live candle — just compute on current state
        tentative = arr;
      } else {
        const buffer = priceStream.candleBuffer?.[pair];
        if (buffer?.open) {
          tentative = [...arr, { o: buffer.open, h: buffer.high, l: buffer.low, c: buffer.close, v: 0, ts: buffer.ts_start }];
        } else {
          tentative = arr;
        }
      }

      if (tentative.length < 20) continue;
      try {
        const data = toIndicatorData(tentative);
        const ind = computeIndicators(data, '5m-live');
        if (ind && !ind.error) {
          const warnings = detectSignals(pair, ind, indicatorCache[pair]?.['5m']);
          if (warnings.length > 0) {
            const now = Date.now();
            if (!alertCooldowns[pair] || now - alertCooldowns[pair] > ALERT_COOLDOWN) {
              alertCooldowns[pair] = now;
              _log.info('kline_warning', { module: 'kline', pair, warnings: warnings.map(w => w.detail) });
            }
          }
        }
      } catch {}
    }
  }

  // =====================================================
  // Dynamic subscription management
  // =====================================================

  async function subscribe(pair) {
    if (activePairs.has(pair)) return { status: 'already_subscribed', pair };
    activePairs.add(pair);
    loadHistory(pair);

    // Seed from REST if insufficient history
    const loaded = candleArrays[pair]?.['5m']?.length || 0;
    if (loaded < 50) {
      try { await seedFromBitget(pair); } catch (e) {
        _log.warn('kline_seed_failed', { module: 'kline', pair, error: e.message });
      }
    }

    // Subscribe on Bitget WS for live updates
    _wsSubscribe(pair);

    const final = candleArrays[pair]?.['5m']?.length || 0;
    _log.info('kline_subscribed', { module: 'kline', pair, total: activePairs.size, candles: final, ws: wsSubscribed.has(pair) });
    return { status: 'subscribed', pair, candles: final, ws_live: wsSubscribed.has(pair) };
  }

  function unsubscribe(pair) {
    if (!activePairs.has(pair)) return { status: 'not_subscribed', pair };
    if (basePairs.includes(pair)) return { status: 'cannot_remove_base', pair };
    activePairs.delete(pair);
    _wsUnsubscribe(pair);
    delete candleArrays[pair];
    delete indicatorCache[pair];
    delete lastCandleTs[pair];
    _log.info('kline_unsubscribed', { module: 'kline', pair, total: activePairs.size });
    return { status: 'unsubscribed', pair };
  }

  function getStatus() {
    const pairs = [];
    for (const pair of activePairs) {
      const c5m = candleArrays[pair]?.['5m']?.length || 0;
      const ind = indicatorCache[pair]?.['5m'];
      pairs.push({
        pair,
        candles_5m: c5m,
        ws_live: wsSubscribed.has(pair),
        last_computed: ind?.computed_at || null,
        price: ind?.price || null,
        rsi14: ind?.rsi14 ? +ind.rsi14.toFixed(1) : null,
        ema20: ind?.ema20 ? +ind.ema20.toFixed(2) : null,
        macd_cross: ind?.macd_cross || null,
      });
    }
    return pairs;
  }

  // =====================================================
  // Lifecycle
  // =====================================================

  function start() {
    for (const pair of activePairs) loadHistory(pair);
    _initializing = false;  // done loading history, enable signal detection
    connectBitgetWS();
    snapshotTimer = setInterval(runSnapshot, SNAPSHOT_MS);
    _log.info('kline_monitor_started', { module: 'kline', pairs: [...activePairs], snapshot_ms: SNAPSHOT_MS });
  }

  function stop() {
    if (snapshotTimer) { clearInterval(snapshotTimer); snapshotTimer = null; }
    if (_pingInterval) { clearInterval(_pingInterval); _pingInterval = null; }
    if (_ws) { try { _ws.close(); } catch {} }
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  }

  function getIndicators(pair, timeframe = '5m') {
    return indicatorCache[pair]?.[timeframe] || null;
  }

  return { start, stop, onCandleClose, getIndicators, subscribe, unsubscribe, getStatus, indicatorCache };
}
