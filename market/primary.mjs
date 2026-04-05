/**
 * Primary Market Module — orchestrates pool detection + security scan + TG push.
 *
 * Flow: PoolCreated event → token scan → if safe, push to TG news topic
 */

import { createPoolListener } from './pool-listener.mjs';
import { createTokenScanner } from './token-scan.mjs';

export function createPrimaryMarket({ config, pushEngine, tgCall, log, metrics }) {
  const _log = log || { info() {}, warn() {}, error() {} };
  const _m = metrics || { record() {} };

  const scanner = createTokenScanner({ log });
  let listener = null;

  // Recent pools (dedup within 1h)
  const recentPools = new Map();
  const DEDUP_WINDOW = 60 * 60 * 1000;

  /**
   * Called when a new pool is detected.
   */
  async function onNewPool(poolInfo) {
    const key = poolInfo.newToken.address.toLowerCase();

    // Dedup
    if (recentPools.has(key)) return;
    recentPools.set(key, Date.now());
    if (recentPools.size > 200) {
      const cutoff = Date.now() - DEDUP_WINDOW;
      for (const [k, ts] of recentPools) { if (ts < cutoff) recentPools.delete(k); }
    }

    _m.record('new_pool_detected', 1, { base: poolInfo.baseToken.symbol });

    // Security scan
    const scanResult = await scanner.scan(poolInfo.newToken.address, 'base');

    _m.record('token_scanned', 1, { safe: scanResult.safe, score: scanResult.score });

    // Format and push
    const text = scanner.formatForPush(poolInfo, scanResult);

    // Push to news topic
    const dashChat = config.TG_DASHBOARD_CHAT;
    const newsThread = config.TG_TOPIC_NEWS;

    if (dashChat && newsThread && tgCall) {
      try {
        await tgCall('sendMessage', {
          chat_id: dashChat,
          message_thread_id: Number(newsThread),
          text: text.slice(0, 4000),
        });
      } catch (err) {
        _log.error('pool_push_failed', { module: 'primary', error: err.message });
      }
    }

    // Also store in push_history via pushEngine
    if (pushEngine && scanResult.safe) {
      await pushEngine.pushFlash({
        analysis: {
          push_worthy: true,
          push_reason: `新池: ${poolInfo.newToken.symbol}/${poolInfo.baseToken.symbol} (safety: ${scanResult.score})`,
          recommended_action: 'hold',
          confidence: scanResult.score,
        },
        news: [],
        traceId: `pool_${poolInfo.pool.slice(0, 10)}_${Date.now()}`,
      }).catch(() => {});
    }

    _log.info('pool_processed', {
      module: 'primary',
      symbol: poolInfo.newToken.symbol,
      safe: scanResult.safe,
      score: scanResult.score,
    });
  }

  function start() {
    if (!config.BASE_WS_RPC) {
      _log.warn('primary_market_disabled', { module: 'primary', reason: 'BASE_WS_RPC not set' });
      return;
    }

    listener = createPoolListener({ config, log, onNewPool });
    listener.start();
    _log.info('primary_market_started', { module: 'primary' });
  }

  function stop() {
    if (listener) listener.stop();
  }

  return { start, stop };
}
