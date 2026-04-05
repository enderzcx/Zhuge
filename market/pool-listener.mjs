/**
 * Base V3 Pool Listener — monitors Uniswap V3 Factory for new pool creation.
 *
 * Listens to PoolCreated events via WebSocket, filters for WETH/USDC pairs,
 * triggers security scan + TG push.
 *
 * Uses viem for ABI decoding + WebSocket subscription.
 */

import { createPublicClient, webSocket, parseAbiItem, formatUnits } from 'viem';
import { base } from 'viem/chains';

// Uniswap V3 Factory on Base
const V3_FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const POOL_CREATED_EVENT = parseAbiItem(
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)'
);

// Known base tokens (pairs we care about)
const BASE_TOKENS = {
  '0x4200000000000000000000000000000000000006': 'WETH',
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913': 'USDC',
  '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6Ca': 'USDbC',
  '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb': 'DAI',
};

const RECONNECT_DELAY = 5000;
const MAX_RECONNECT = 10;

export function createPoolListener({ config, log, onNewPool }) {
  const _log = log || { info() {}, warn() {}, error() {} };
  const rpcWs = config.BASE_WS_RPC || 'wss://base-mainnet.g.alchemy.com/v2/demo';

  let client = null;
  let unwatch = null;
  let reconnectCount = 0;
  let running = false;

  /**
   * Start listening for PoolCreated events.
   */
  function start() {
    if (running) return;
    running = true;
    _connect();
    _log.info('pool_listener_started', { module: 'pool-listener', factory: V3_FACTORY });
  }

  function _connect() {
    // Cleanup previous connection
    try { if (unwatch) { unwatch(); unwatch = null; } } catch {}
    try { if (client?.transport?.close) client.transport.close(); } catch {}

    try {
      client = createPublicClient({
        chain: base,
        transport: webSocket(rpcWs, {
          reconnect: { maxAttempts: 3 },
        }),
      });

      unwatch = client.watchEvent({
        address: V3_FACTORY,
        event: POOL_CREATED_EVENT,
        onLogs: (logs) => {
          for (const log of logs) {
            _handlePoolCreated(log);
          }
        },
        onError: (err) => {
          _log.error('pool_listener_error', { module: 'pool-listener', error: err.message });
          _reconnect();
        },
      });

      reconnectCount = 0;
      _log.info('pool_listener_connected', { module: 'pool-listener' });
    } catch (err) {
      _log.error('pool_listener_connect_failed', { module: 'pool-listener', error: err.message });
      _reconnect();
    }
  }

  function _reconnect() {
    if (!running || reconnectCount >= MAX_RECONNECT) return;
    reconnectCount++;
    _log.warn('pool_listener_reconnecting', { module: 'pool-listener', attempt: reconnectCount });
    setTimeout(_connect, RECONNECT_DELAY * reconnectCount);
  }

  /**
   * Handle a PoolCreated event.
   */
  async function _handlePoolCreated(eventLog) {
    const { token0, token1, fee, pool } = eventLog.args;

    // Identify which is the base token and which is the new token
    const token0Lower = token0.toLowerCase();
    const token1Lower = token1.toLowerCase();
    const base0 = Object.entries(BASE_TOKENS).find(([addr]) => addr.toLowerCase() === token0Lower);
    const base1 = Object.entries(BASE_TOKENS).find(([addr]) => addr.toLowerCase() === token1Lower);

    // Only care about pairs with a known base token
    if (!base0 && !base1) return;

    const baseToken = base0 ? { address: token0, symbol: base0[1] } : { address: token1, symbol: base1[1] };
    const newToken = base0 ? { address: token1, symbol: null } : { address: token0, symbol: null };

    // Try to get token info
    let tokenName = 'Unknown';
    let tokenSymbol = 'UNKNOWN';
    try {
      const [nameRes, symbolRes] = await Promise.all([
        client.readContract({ address: newToken.address, abi: [parseAbiItem('function name() view returns (string)')], functionName: 'name' }),
        client.readContract({ address: newToken.address, abi: [parseAbiItem('function symbol() view returns (string)')], functionName: 'symbol' }),
      ]);
      tokenName = nameRes;
      tokenSymbol = symbolRes;
    } catch {}

    const feePercent = Number(fee) / 10000;
    const poolInfo = {
      pool,
      token0, token1, fee,
      baseToken,
      newToken: { ...newToken, name: tokenName, symbol: tokenSymbol },
      feePercent,
      timestamp: new Date().toISOString(),
      txHash: eventLog.transactionHash,
      blockNumber: Number(eventLog.blockNumber),
    };

    _log.info('new_pool_detected', {
      module: 'pool-listener',
      symbol: tokenSymbol,
      pair: `${tokenSymbol}/${baseToken.symbol}`,
      fee: `${feePercent}%`,
      pool,
    });

    // Callback to security scanner + push
    if (onNewPool) {
      try { await onNewPool(poolInfo); } catch (err) {
        _log.error('on_new_pool_error', { module: 'pool-listener', error: err.message });
      }
    }
  }

  function stop() {
    running = false;
    if (unwatch) { unwatch(); unwatch = null; }
  }

  return { start, stop };
}
