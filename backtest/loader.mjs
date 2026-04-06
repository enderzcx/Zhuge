/**
 * Backtest data loader — fetch historical candles from Bitget API → SQLite.
 * Handles pagination (max 1000 per request), deduplication, and rate limiting.
 */

const BITGET_BASE = 'https://api.bitget.com';
const MAX_PER_REQUEST = 1000;
const RATE_LIMIT_MS = 200; // be nice to the API

const TF_MS = {
  '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000,
  '1H': 3600000, '4H': 14400000, '1D': 86400000,
};

/**
 * Load historical candles from Bitget into backtest_candles table.
 * @param {object} db - better-sqlite3 instance (raw, not wrapped)
 * @param {string} symbol - e.g. 'BTCUSDT'
 * @param {string} timeframe - e.g. '1H'
 * @param {number} startTs - start timestamp ms
 * @param {number} endTs - end timestamp ms
 * @param {object} [log]
 * @returns {{ loaded: number, skipped: number }}
 */
export async function loadCandles(db, symbol, timeframe, startTs, endTs, log) {
  const _log = log || { info() {}, warn() {} };
  const tfMs = TF_MS[timeframe];
  if (!tfMs) throw new Error(`Unsupported timeframe: ${timeframe}`);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO backtest_candles (pair, timeframe, ts, open, high, low, close, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let cursor = startTs;
  let loaded = 0, skipped = 0;

  while (cursor < endTs) {
    const batchEnd = Math.min(cursor + MAX_PER_REQUEST * tfMs, endTs);
    const url = `${BITGET_BASE}/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${timeframe}&startTime=${cursor}&endTime=${batchEnd}&limit=${MAX_PER_REQUEST}`;

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) { _log.warn('backtest_fetch_error', { status: res.status, symbol, timeframe }); break; }
      const json = await res.json();
      const candles = json.data || json;
      if (!Array.isArray(candles) || candles.length === 0) break;

      const insertMany = db.transaction((rows) => {
        for (const c of rows) {
          const ts = parseInt(c[0]);
          const info = insert.run(symbol, timeframe, ts, parseFloat(c[1]), parseFloat(c[2]), parseFloat(c[3]), parseFloat(c[4]), parseFloat(c[5] || 0));
          if (info.changes > 0) loaded++; else skipped++;
        }
      });
      insertMany(candles);

      // Move cursor past the last candle
      const maxTs = Math.max(...candles.map(c => parseInt(c[0])));
      cursor = maxTs + tfMs;

      _log.info('backtest_batch', { symbol, timeframe, loaded: candles.length, cursor: new Date(cursor).toISOString() });
    } catch (err) {
      _log.warn('backtest_fetch_failed', { symbol, error: err.message });
      break;
    }

    await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
  }

  _log.info('backtest_load_done', { symbol, timeframe, loaded, skipped });
  return { loaded, skipped };
}

/**
 * Check how many candles we have for a symbol/timeframe.
 */
export function candleCount(db, symbol, timeframe) {
  const row = db.prepare('SELECT COUNT(*) as cnt, MIN(ts) as minTs, MAX(ts) as maxTs FROM backtest_candles WHERE pair = ? AND timeframe = ?').get(symbol, timeframe);
  return { count: row.cnt, from: row.minTs ? new Date(row.minTs).toISOString() : null, to: row.maxTs ? new Date(row.maxTs).toISOString() : null };
}
