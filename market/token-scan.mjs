/**
 * Token Security Scanner — honeypot detection + basic safety checks.
 *
 * Uses GoPlus Security API (free, no key needed) to check:
 *   - Honeypot (can't sell)
 *   - Ownership renounced
 *   - Open source
 *   - Blacklist functions
 *   - Tax (buy/sell)
 */

const GOPLUS_API = 'https://api.gopluslabs.io/api/v1/token_security';
const SCAN_TIMEOUT = 15000;

// Chain IDs for GoPlus
const CHAIN_IDS = { base: '8453', ethereum: '1', bsc: '56' };

export function createTokenScanner({ log }) {
  const _log = log || { info() {}, warn() {}, error() {} };

  /**
   * Scan a token for security issues.
   * @param {string} address - token contract address
   * @param {string} chain - 'base' | 'ethereum' | 'bsc'
   * @returns {{ safe: boolean, score: number, risks: string[], details: object }}
   */
  async function scan(address, chain = 'base') {
    const chainId = CHAIN_IDS[chain] || '8453';

    try {
      const res = await fetch(
        `${GOPLUS_API}/${chainId}?contract_addresses=${address}`,
        { signal: AbortSignal.timeout(SCAN_TIMEOUT) }
      );

      if (!res.ok) throw new Error(`GoPlus API ${res.status}`);
      const data = await res.json();

      const tokenData = data.result?.[address.toLowerCase()];
      if (!tokenData) {
        return { safe: false, score: 0, risks: ['Token not found in GoPlus'], details: {} };
      }

      const risks = [];
      let score = 100;

      // Critical checks (instant fail)
      if (tokenData.is_honeypot === '1') {
        risks.push('HONEYPOT — cannot sell');
        score = 0;
      }
      if (tokenData.is_blacklisted === '1') {
        risks.push('Has blacklist function');
        score -= 30;
      }
      if (tokenData.can_take_back_ownership === '1') {
        risks.push('Can reclaim ownership');
        score -= 25;
      }
      if (tokenData.is_proxy === '1') {
        risks.push('Proxy contract (upgradeable)');
        score -= 15;
      }

      // Tax checks
      const buyTax = parseFloat(tokenData.buy_tax || 0) * 100;
      const sellTax = parseFloat(tokenData.sell_tax || 0) * 100;
      if (buyTax > 10) { risks.push(`High buy tax: ${buyTax.toFixed(1)}%`); score -= 20; }
      if (sellTax > 10) { risks.push(`High sell tax: ${sellTax.toFixed(1)}%`); score -= 20; }

      // Positive signals
      if (tokenData.is_open_source === '1') score += 5;
      if (tokenData.owner_address === '0x0000000000000000000000000000000000000000') score += 10;

      // Holder concentration
      const topHolder = parseFloat(tokenData.holder_count || 0);
      if (topHolder < 10) { risks.push(`Very few holders: ${topHolder}`); score -= 15; }

      score = Math.max(0, Math.min(100, score));

      const details = {
        name: tokenData.token_name,
        symbol: tokenData.token_symbol,
        is_honeypot: tokenData.is_honeypot === '1',
        is_open_source: tokenData.is_open_source === '1',
        owner_renounced: tokenData.owner_address === '0x0000000000000000000000000000000000000000',
        buy_tax: buyTax,
        sell_tax: sellTax,
        holder_count: topHolder,
        is_proxy: tokenData.is_proxy === '1',
        is_blacklisted: tokenData.is_blacklisted === '1',
        total_supply: tokenData.total_supply,
        creator: tokenData.creator_address,
      };

      _log.info('token_scanned', { module: 'token-scan', address, score, risks: risks.length });

      return { safe: score >= 50 && !details.is_honeypot, score, risks, details };
    } catch (err) {
      _log.error('token_scan_failed', { module: 'token-scan', address, error: err.message });
      return { safe: false, score: 0, risks: [`Scan failed: ${err.message}`], details: {} };
    }
  }

  /**
   * Format scan result for TG push.
   */
  function formatForPush(poolInfo, scanResult) {
    const { newToken, baseToken, feePercent, pool } = poolInfo;
    const { safe, score, risks, details } = scanResult;

    const safeIcon = safe ? '✅' : '⚠️';
    const lines = [
      `🆕 New Pool on Base V3`,
      '',
      `${safeIcon} ${newToken.name || newToken.symbol} (${newToken.symbol})`,
      `Pair: ${newToken.symbol}/${baseToken.symbol} (${feePercent}% fee)`,
      `Safety: ${score}/100`,
    ];

    if (details.buy_tax || details.sell_tax) {
      lines.push(`Tax: buy ${details.buy_tax.toFixed(1)}% / sell ${details.sell_tax.toFixed(1)}%`);
    }
    if (details.holder_count) lines.push(`Holders: ${details.holder_count}`);
    if (details.owner_renounced) lines.push('Owner: renounced');
    if (details.is_open_source) lines.push('Source: verified');

    if (risks.length > 0) {
      lines.push('', 'Risks:');
      risks.forEach(r => lines.push(`• ${r}`));
    }

    lines.push('', `Pool: ${pool.slice(0, 10)}...${pool.slice(-6)}`);
    lines.push(`Token: ${newToken.address}`);

    return lines.join('\n');
  }

  return { scan, formatForPush };
}
