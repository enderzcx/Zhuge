/**
 * Bitget Private WebSocket: real-time order fills, position changes, account updates.
 * Replaces polling-based trade sync with event-driven callbacks.
 *
 * Channels:
 *   orders     → order fill events (entry/exit price on fill)
 *   positions  → position open/close/update (unrealized PnL, liquidation)
 *   account    → balance/equity changes
 */

import { createHmac } from 'crypto';
import WebSocket from 'ws';

export function createBitgetWS(config, { log, metrics } = {}) {
  const _log = log || { info: console.log, warn: console.warn, error: console.error };
  const _m = metrics || { record() {} };

  const WS_URL = 'wss://ws.bitget.com/v2/ws/private';

  // Local state cache — the whole point of this module
  let _equity = 0;
  let _available = 0;
  let _positions = [];  // [{ symbol, holdSide, total, unrealizedPL, avgOpenPrice }]
  let _connected = false;
  let _authenticated = false;
  let _accountReady = false;   // true after first account snapshot
  let _positionsReady = false; // true after first positions snapshot
  let _lastMessage = 0;
  let _reconnectTimer = null;
  let _pingInterval = null;
  let _reconnectAttempts = 0;
  let _ws = null;

  // Event callbacks — set by consumer (executor)
  let _onOrderFill = null;
  let _onPositionUpdate = null;
  let _onPositionClose = null;
  let _onEquityUpdate = null;

  function _sign() {
    const ts = String(Math.floor(Date.now() / 1000));
    const msg = ts + 'GET' + '/user/verify';
    const sign = createHmac('sha256', config.BITGET_SECRET).update(msg).digest('base64');
    return { ts, sign };
  }

  function connect() {
    if (!config.BITGET_API_KEY) {
      _log.info('bitget_ws_skip', { module: 'bitget_ws', reason: 'no API key' });
      return;
    }

    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }

    try {
      _ws = new WebSocket(WS_URL);
    } catch (e) {
      _log.error('bitget_ws_create_failed', { module: 'bitget_ws', error: e.message });
      _scheduleReconnect();
      return;
    }

    _ws.on('open', () => {
      _connected = true;
      _reconnectAttempts = 0;
      _lastMessage = Date.now();
      _log.info('bitget_ws_connected', { module: 'bitget_ws' });
      _m.record('ws_connect', 1, { exchange: 'bitget', type: 'private' });

      // Authenticate
      const { ts, sign } = _sign();
      _ws.send(JSON.stringify({
        op: 'login',
        args: [{
          apiKey: config.BITGET_API_KEY,
          passphrase: config.BITGET_PASS,
          timestamp: ts,
          sign,
        }],
      }));
    });

    _ws.on('message', (raw) => {
      _lastMessage = Date.now();
      try {
        const text = raw.toString();
        if (text === 'pong') return;

        const msg = JSON.parse(text);

        // Auth response
        if (msg.event === 'login') {
          if (msg.code === '0') {
            _authenticated = true;
            _log.info('bitget_ws_auth_ok', { module: 'bitget_ws' });
            _subscribe();
          } else {
            _log.error('bitget_ws_auth_failed', { module: 'bitget_ws', code: msg.code, msg: msg.msg });
            _ws.close(); // force reconnect on auth failure
          }
          return;
        }

        // Subscription confirmation
        if (msg.event === 'subscribe') return;

        // Data push
        if (msg.action && msg.data) {
          _handlePush(msg);
        }
      } catch (e) {
        _log.error('bitget_ws_parse_error', { module: 'bitget_ws', error: e.message });
      }
    });

    _ws.on('close', () => {
      _connected = false;
      _authenticated = false;
      _accountReady = false;
      _positionsReady = false;
      if (_pingInterval) { clearInterval(_pingInterval); _pingInterval = null; }
      _log.warn('bitget_ws_disconnected', { module: 'bitget_ws' });
      _m.record('ws_disconnect', 1, { exchange: 'bitget' });
      _scheduleReconnect();
    });

    _ws.on('error', (err) => {
      _log.error('bitget_ws_error', { module: 'bitget_ws', error: err.message });
      _m.record('ws_error', 1, { exchange: 'bitget' });
      _ws.close();
    });

    // Ping every 25s
    _pingInterval = setInterval(() => {
      if (_ws?.readyState === WebSocket.OPEN) {
        _ws.send('ping');
      } else {
        clearInterval(_pingInterval);
        _pingInterval = null;
      }
    }, 25000);
  }

  function _subscribe() {
    const channels = [
      { instType: 'USDT-FUTURES', channel: 'orders', instId: 'default' },
      { instType: 'USDT-FUTURES', channel: 'positions', instId: 'default' },
      { instType: 'USDT-FUTURES', channel: 'account', coin: 'default' },
    ];
    _ws.send(JSON.stringify({ op: 'subscribe', args: channels }));
    _log.info('bitget_ws_subscribed', { module: 'bitget_ws', channels: channels.map(c => c.channel) });
  }

  function _scheduleReconnect() {
    _reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, _reconnectAttempts), 60000); // exp backoff, max 60s
    _log.info('bitget_ws_reconnect_scheduled', { module: 'bitget_ws', attempt: _reconnectAttempts, delay_ms: delay });
    _reconnectTimer = setTimeout(connect, delay);
  }

  function _handlePush(msg) {
    const channel = msg.arg?.channel;
    const action = msg.action; // 'snapshot' or 'update'

    if (channel === 'orders') {
      for (const order of msg.data) {
        // Only care about filled orders
        const status = order.status || order.state || '';
        if (!['filled', 'full_fill'].includes(status)) continue;

        const fill = {
          orderId: order.orderId,
          symbol: order.instId || order.symbol,
          side: order.side,
          tradeSide: order.tradeSide,     // 'open' or 'close'
          fillPrice: parseFloat(order.fillPx || order.priceAvg || '0'),
          fillSize: parseFloat(order.fillSz || order.sz || '0'),
          leverage: parseInt(order.lever || '10', 10),
          fee: parseFloat(order.fee || '0'),
          ts: parseInt(order.uTime || order.cTime || Date.now()),
        };

        _log.info('bitget_ws_order_fill', { module: 'bitget_ws', ...fill });
        _m.record('ws_order_fill', 1, { symbol: fill.symbol, side: fill.side });

        if (_onOrderFill) {
          try { _onOrderFill(fill); } catch (e) {
            _log.error('bitget_ws_fill_handler_error', { module: 'bitget_ws', error: e.message });
          }
        }
      }
    }

    if (channel === 'positions') {
      const newPositions = msg.data.map(p => ({
        symbol: p.instId || p.symbol,
        holdSide: p.holdSide,
        total: parseFloat(p.total || '0'),
        available: parseFloat(p.available || '0'),
        unrealizedPL: parseFloat(p.upl || p.unrealizedPL || '0'),
        avgOpenPrice: parseFloat(p.averageOpenPrice || p.openPriceAvg || '0'),
        leverage: parseInt(p.lever || p.leverage || '10', 10),
        marginMode: p.marginMode || 'crossed',
        uTime: parseInt(p.uTime || Date.now()),
      }));

      // Detect closed positions (was in _positions, not in new data or total=0)
      if (action === 'snapshot' || _positions.length > 0) {
        for (const old of _positions) {
          const still = newPositions.find(n => n.symbol === old.symbol && n.holdSide === old.holdSide && n.total > 0);
          if (!still && old.total > 0) {
            _log.info('bitget_ws_position_closed', { module: 'bitget_ws', symbol: old.symbol, side: old.holdSide });
            if (_onPositionClose) {
              try { _onPositionClose({ symbol: old.symbol, holdSide: old.holdSide, prevSize: old.total }); } catch (e) {
                _log.error('bitget_ws_close_handler_error', { module: 'bitget_ws', error: e.message });
              }
            }
          }
        }
      }

      _positions = newPositions;
      _positionsReady = true;

      if (_onPositionUpdate) {
        try { _onPositionUpdate(_positions); } catch (e) {
          _log.error('bitget_ws_pos_handler_error', { module: 'bitget_ws', error: e.message });
        }
      }
    }

    if (channel === 'account') {
      for (const acct of msg.data) {
        if (acct.marginCoin === 'USDT' || acct.coin === 'USDT') {
          const newEquity = parseFloat(acct.equity || acct.accountEquity || '0');
          const newAvailable = parseFloat(acct.crossedMaxAvailable || acct.available || '0');
          if (Number.isFinite(newEquity)) _equity = newEquity;
          if (Number.isFinite(newAvailable)) _available = newAvailable;
          _accountReady = true;

          _log.info('bitget_ws_account_update', { module: 'bitget_ws', equity: _equity, available: _available });
          _m.record('ws_account_update', 1);

          if (_onEquityUpdate) {
            try { _onEquityUpdate({ equity: _equity, available: _available }); } catch (e) {
              _log.error('bitget_ws_equity_handler_error', { module: 'bitget_ws', error: e.message });
            }
          }
        }
      }
    }
  }

  // --- Public API ---

  /** Cached equity. Returns 0 only if WS never connected or no USDT account. */
  function getEquity() { return _equity; }

  /** Cached available balance. */
  function getAvailable() { return _available; }

  /** Cached positions list. */
  function getPositions() { return [..._positions]; }

  /** Total unrealized PnL across all positions. */
  function getUnrealizedPnL() {
    return _positions.reduce((s, p) => s + (p.unrealizedPL || 0), 0);
  }

  /** Is WS connected, authenticated, data loaded, and fresh (< 60s since last message)? */
  function isHealthy() {
    return _connected && _authenticated && _accountReady && (Date.now() - _lastMessage < 60000);
  }

  /** Register event callbacks. */
  function onOrderFill(fn) { _onOrderFill = fn; }
  function onPositionClose(fn) { _onPositionClose = fn; }
  function onPositionUpdate(fn) { _onPositionUpdate = fn; }
  function onEquityUpdate(fn) { _onEquityUpdate = fn; }

  return {
    connect,
    getEquity, getAvailable, getPositions, getUnrealizedPnL,
    isHealthy,
    onOrderFill, onPositionClose, onPositionUpdate, onEquityUpdate,
  };
}
