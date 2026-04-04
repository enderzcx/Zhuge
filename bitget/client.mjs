/**
 * Bitget API client: signing + authenticated/public requests.
 */

import { createHmac } from 'crypto';

export function createBitgetClient(config) {
  function bitgetSign(ts, method, path, body = '') {
    const msg = ts + method + path + body;
    return createHmac('sha256', config.BITGET_SECRET).update(msg).digest('base64');
  }

  async function bitgetRequest(method, path, body = null) {
    const ts = String(Date.now());
    const bodyStr = body ? JSON.stringify(body) : '';
    const sig = bitgetSign(ts, method, path, bodyStr);
    const res = await fetch(`${config.BITGET_BASE}${path}`, {
      method,
      headers: {
        'ACCESS-KEY': config.BITGET_API_KEY,
        'ACCESS-SIGN': sig,
        'ACCESS-TIMESTAMP': ts,
        'ACCESS-PASSPHRASE': config.BITGET_PASS,
        'Content-Type': 'application/json',
        'locale': 'en-US',
      },
      body: bodyStr || undefined,
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    if (data.code !== '00000') throw new Error(`Bitget ${data.code}: ${data.msg}`);
    return data.data;
  }

  async function bitgetPublic(path) {
    const res = await fetch(`${config.BITGET_BASE}${path}`, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    if (data.code && data.code !== '00000') throw new Error(`Bitget ${data.code}: ${data.msg}`);
    return data.data;
  }

  // ── Symbol info cache (tick size / price precision) ──────────────────
  const _symbolInfoCache = new Map();
  let _symbolInfoExpiry = 0;

  async function _loadSymbolInfo() {
    if (Date.now() < _symbolInfoExpiry && _symbolInfoCache.size > 0) return;
    try {
      const data = await bitgetPublic('/api/v2/mix/market/contracts?productType=USDT-FUTURES');
      if (Array.isArray(data)) {
        for (const s of data) {
          _symbolInfoCache.set(s.symbol, {
            pricePlace: parseInt(s.pricePlace || '2', 10),
            priceEndStep: parseFloat(s.priceEndStep || '1'),
            volumePlace: parseInt(s.volumePlace || '4', 10),
          });
        }
        _symbolInfoExpiry = Date.now() + 60 * 60 * 1000; // cache 1h
      }
    } catch (e) {
      console.error('[SymbolInfo] Failed to load:', e.message);
    }
  }

  /**
   * Round a price to the exchange's tick size for a given symbol.
   * Falls back to toPrecision(6) if symbol info unavailable.
   */
  async function roundPrice(symbol, price) {
    await _loadSymbolInfo();
    const info = _symbolInfoCache.get(symbol);
    if (!info) return parseFloat(price.toPrecision(6));
    const step = info.priceEndStep * Math.pow(10, -info.pricePlace);
    const rounded = Math.round(price / step) * step;
    return parseFloat(rounded.toFixed(info.pricePlace));
  }

  return { bitgetSign, bitgetRequest, bitgetPublic, roundPrice };
}
