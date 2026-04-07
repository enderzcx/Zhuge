/**
 * Bitget API client: signing + authenticated/public requests.
 */

import { createHmac } from 'crypto';
import { startChildSpan, endSpan } from '../agent/observe/tracing.mjs';
import { context } from '@opentelemetry/api';

export function createBitgetClient(config, { metrics, log } = {}) {
  let _consecutiveFailures = 0;
  let _lastError = null;
  let _backoffUntil = 0; // rate-limit backoff timestamp
  function bitgetSign(ts, method, path, body = '') {
    const msg = ts + method + path + body;
    return createHmac('sha256', config.BITGET_SECRET).update(msg).digest('base64');
  }

  async function bitgetRequest(method, path, body = null) {
    // Rate-limit backoff: reject immediately if still in cooldown
    if (Date.now() < _backoffUntil) {
      const waitSec = ((_backoffUntil - Date.now()) / 1000).toFixed(1);
      throw new Error(`Bitget rate-limited, backoff ${waitSec}s remaining`);
    }
    const { span } = startChildSpan(context.active(),`bitget:${path.split('?')[0]}`, { method });
    const ts = String(Date.now());
    const bodyStr = body ? JSON.stringify(body) : '';
    const sig = bitgetSign(ts, method, path, bodyStr);
    const start = Date.now();
    try {
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
    const latency = Date.now() - start;
    metrics?.record('bitget_api_latency_ms', latency, { method, path: path.split('?')[0] });
    if (data.code !== '00000') {
      metrics?.record('bitget_api_error', 1, { code: data.code, path: path.split('?')[0] });
      _consecutiveFailures++;
      _lastError = `${data.code}: ${data.msg}`;
      // Rate limit detection — Bitget uses 429xx codes or HTTP 429
      if (data.code === '429' || String(data.code).startsWith('429') || res.status === 429) {
        const backoffMs = Math.min(1000 * Math.pow(2, _consecutiveFailures), 60000); // exp backoff, max 60s
        _backoffUntil = Date.now() + backoffMs;
        log?.warn?.('bitget_rate_limited', { backoffMs, until: new Date(_backoffUntil).toISOString() });
      }
      if (_consecutiveFailures >= 3) {
        log?.warn?.('bitget_consecutive_failures', { count: _consecutiveFailures, lastError: _lastError });
      }
      throw new Error(`Bitget ${data.code}: ${data.msg}`);
    }
    _consecutiveFailures = 0;
    endSpan(span);
    return data.data;
    } catch (e) {
      endSpan(span, e);
      throw e;
    }
  }

  async function bitgetPublic(path) {
    const { span } = startChildSpan(context.active(),`bitget:${path.split('?')[0]}`, { method: 'GET' });
    const start = Date.now();
    try {
    const res = await fetch(`${config.BITGET_BASE}${path}`, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    const latency = Date.now() - start;
    metrics?.record('bitget_api_latency_ms', latency, { method: 'GET', path: path.split('?')[0] });
    if (data.code && data.code !== '00000') throw new Error(`Bitget ${data.code}: ${data.msg}`);
    _consecutiveFailures = 0;
    endSpan(span);
    return data.data;
    } catch (e) {
      endSpan(span, e);
      throw e;
    }
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
      log?.error?.('symbol_info_load_failed', { module: 'bitget_client', error: e.message });
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
