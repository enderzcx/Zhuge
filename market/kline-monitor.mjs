/**
 * Real-time K-line monitor — continuous indicator computation + signal detection.
 *
 * Two-layer trigger:
 *   1. Snapshot (every 60s): compute indicators on current candles, detect warnings (no trading)
 *   2. Candle close (5m): compute on finalized candles, detect signals → trigger pipeline
 *
 * Multi-timeframe: aggregates 5m → 15m → 1h in memory.
 */

import { computeIndicators } from './indicators.mjs';

export function createKlineMonitor({ db, priceStream, pipeline, messageBus, config, log, metrics }) {
  const _log = log || { info() {}, warn() {}, error() {} };
  const _m = metrics || { record() {} };
  const CONF = config.KLINE_MONITOR || {};
  if (!CONF.enabled) return { start() {}, stop() {}, onCandleClose() {}, getIndicators() { return null; } };

  const PAIRS = config.PRICE_PAIRS || ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'];
  const SNAPSHOT_MS = CONF.snapshot_interval_ms || 60_000;
  const SIGNAL_COOLDOWN = CONF.signal_cooldown_ms || 60_000;
  const ALERT_COOLDOWN = CONF.alert_cooldown_ms || 300_000;
  const HISTORY = CONF.history_candles || 200;
  const SIG = CONF.signals || {};

  let snapshotTimer = null;
  let lastSignalTime = 0;
  const alertCooldowns = {};  // pair → ts

  // --- Per-symbol indicator cache (latest computed) ---
  const indicatorCache = {};  // { 'BTC-USDT': { '5m': {...}, '15m': {...}, '1h': {...} } }

  // --- In-memory candle arrays for aggregation ---
  const candleArrays = {};    // { 'BTC-USDT': { '5m': [{ o, h, l, c, ts }], '15m': [...], '1h': [...] } }

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
      // Reverse to oldest-first
      candleArrays[pair]['5m'] = rows.reverse().map(r => ({
        o: r.open, h: r.high, l: r.low, c: r.close, ts: r.ts_start,
      }));
      // Build 15m and 1h from 5m
      candleArrays[pair]['15m'] = aggregateCandles(candleArrays[pair]['5m'], 3);
      candleArrays[pair]['1h'] = aggregateCandles(candleArrays[pair]['5m'], 12);
      _log.info('kline_history_loaded', { module: 'kline', pair, candles_5m: candleArrays[pair]['5m'].length });
    } catch (e) {
      _log.error('kline_history_load_failed', { module: 'kline', pair, error: e.message });
    }
  }

  // --- Aggregate N small candles into 1 larger candle ---
  function aggregateCandles(candles, factor) {
    const result = [];
    for (let i = 0; i + factor <= candles.length; i += factor) {
      const chunk = candles.slice(i, i + factor);
      result.push({
        o: chunk[0].o,
        h: Math.max(...chunk.map(c => c.h)),
        l: Math.min(...chunk.map(c => c.l)),
        c: chunk[chunk.length - 1].c,
        ts: chunk[0].ts,
      });
    }
    return result;
  }

  // --- Convert our candle format to indicators input ---
  function toIndicatorData(candles) {
    return {
      closes: candles.map(c => c.c),
      highs: candles.map(c => c.h),
      lows: candles.map(c => c.l),
      opens: candles.map(c => c.o),
      volumes: candles.map(() => 0), // no volume from OKX ticks, use 0
    };
  }

  // --- Compute indicators for a pair + timeframe ---
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

  // --- Signal detection on finalized candle close ---
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

    return signals;
  }

  // --- Candle close handler (called by prices.mjs on bucket transition) ---
  function onCandleClose(pair, candle) {
    initPair(pair);

    // Append to 5m array (keep last HISTORY candles)
    const arr5m = candleArrays[pair]['5m'];
    arr5m.push({ o: candle.open, h: candle.high, l: candle.low, c: candle.close, ts: candle.ts_start });
    if (arr5m.length > HISTORY) arr5m.shift();

    // Re-aggregate higher timeframes
    candleArrays[pair]['15m'] = aggregateCandles(arr5m, 3);
    candleArrays[pair]['1h'] = aggregateCandles(arr5m, 12);

    // Compute indicators for all timeframes
    const prev5m = indicatorCache[pair]?.['5m'] || null;
    const ind5m = computeForPair(pair, '5m');
    computeForPair(pair, '15m');
    computeForPair(pair, '1h');

    if (!ind5m) return;

    // Detect signals on 5m (primary timeframe)
    const signals = detectSignals(pair, ind5m, prev5m);
    if (signals.length > 0) {
      _log.info('kline_signal', { module: 'kline', pair, signals: signals.map(s => s.detail) });
      _m.record('kline_signal_count', signals.length, { pair });

      // Post to message bus
      messageBus?.postMessage?.('kline-monitor', 'analyst', 'KLINE_SIGNAL', { pair, signals, indicators: ind5m });

      // Trigger pipeline if cooldown allows
      const now = Date.now();
      if (now - lastSignalTime > SIGNAL_COOLDOWN) {
        lastSignalTime = now;
        _log.info('kline_trigger_pipeline', { module: 'kline', pair, signals: signals.length });
        pipeline?.collectAndAnalyze?.().catch(e =>
          _log.error('kline_pipeline_trigger_error', { module: 'kline', error: e.message })
        );
      }
    }

    _log.info('kline_close', { module: 'kline', pair, close: candle.close, ema20: ind5m.ema20?.toFixed(2), rsi14: ind5m.rsi14?.toFixed(1), macd_cross: ind5m.macd_cross });
  }

  // --- Snapshot: periodic check on current state (warnings only, no trading) ---
  function runSnapshot() {
    for (const pair of PAIRS) {
      if (!candleArrays[pair]?.['5m']?.length) continue;

      // Add current buffer as tentative candle
      const buffer = priceStream.candleBuffer?.[pair];
      if (buffer?.open) {
        const tentative = [...candleArrays[pair]['5m'], { o: buffer.open, h: buffer.high, l: buffer.low, c: buffer.close, ts: buffer.ts_start }];
        const data = toIndicatorData(tentative);
        try {
          const ind = computeIndicators(data, '5m-live');
          if (ind && !ind.error) {
            // Check for warnings (not signals — no pipeline trigger)
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
  }

  // --- Public API ---

  function start() {
    // Load history for all pairs
    for (const pair of PAIRS) loadHistory(pair);

    // Start periodic snapshot
    snapshotTimer = setInterval(runSnapshot, SNAPSHOT_MS);
    _log.info('kline_monitor_started', { module: 'kline', pairs: PAIRS, snapshot_ms: SNAPSHOT_MS });
  }

  function stop() {
    if (snapshotTimer) { clearInterval(snapshotTimer); snapshotTimer = null; }
  }

  /**
   * Get cached indicators for a symbol and timeframe.
   * Used by agent tools to answer "what's BTC's current technical setup?" instantly.
   */
  function getIndicators(pair, timeframe = '5m') {
    return indicatorCache[pair]?.[timeframe] || null;
  }

  return { start, stop, onCandleClose, getIndicators, indicatorCache };
}
