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

  return { bitgetSign, bitgetRequest, bitgetPublic };
}
