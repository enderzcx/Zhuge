/**
 * LiFi cross-chain swap integration.
 */

import { readFileSync } from 'fs';
import { createConfig as lifiCreateConfig, getQuote as lifiGetQuote } from '@lifi/sdk';
import { parseUnits, formatUnits } from 'viem';

export function createLiFi(config) {
  const LIFI_DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';
  const SESSION_MANAGER_V2 = '0x342168e8D2BF8315BbF72F409A94f1EC7570f611';

  const CHAIN_MAP = { base: 8453, ethereum: 1, bsc: 56 };

  const TOKEN_REGISTRY = {
    'USDC:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    'USDC:1': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    'USDC:56': '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    'WETH:8453': '0x4200000000000000000000000000000000000006',
    'WETH:1': '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    'ETH:8453': '0x0000000000000000000000000000000000000000',
    'ETH:1': '0x0000000000000000000000000000000000000000',
    'BNB:56': '0x0000000000000000000000000000000000000000',
    // Ondo GM tokens — BSC (primary, cheap gas)
    'AAPLon:56': '0x390a684ef9cade28a7ad0dfa61ab1eb3842618c4',
    'NVDAon:56': '0xa9ee28c80f960b889dfbd1902055218cba016f75',
    'TSLAon:56': '0x2494b603319d4d9f9715c9f4496d9e0364b59d93',
    'SPYon:56':  '0x6a708ead771238919d85930b5a0f10454e1c331a',
    // Ondo GM tokens — Ethereum (expensive gas, backup)
    'AAPLon:1': 'placeholder',
    'NVDAon:1': 'placeholder',
    'SPYon:1': 'placeholder',
  };

  function resolveToken(symbol, chainId) {
    // If it's already an address, return as-is
    if (symbol.startsWith('0x') && symbol.length === 42) return symbol;
    // Try exact match first (for case-sensitive tokens like AAPLon), then uppercase
    return TOKEN_REGISTRY[`${symbol}:${chainId}`] || TOKEN_REGISTRY[`${symbol.toUpperCase()}:${chainId}`] || null;
  }

  // Initialize LiFi SDK
  let lifiReady = false;
  try {
    const pk = process.env.PRIVATE_KEY || (() => {
      try {
        return readFileSync('.env', 'utf-8').split('\n').find(l => l.startsWith('PRIVATE_KEY'))?.split('=')[1]?.trim();
      } catch { return null; }
    })();
    if (pk) {
      lifiCreateConfig({ integrator: 'RIFI' });
      lifiReady = true;
      console.log('[LiFi] SDK initialized');
    }
  } catch (e) { console.warn('[LiFi] Init failed:', e.message); }

  async function lifiSwap({ fromChain, toChain, fromToken, toToken, amount, userAddress }) {
    if (!lifiReady) throw new Error('LiFi SDK not initialized');

    const fromChainId = CHAIN_MAP[fromChain] || parseInt(fromChain);
    const toChainId = CHAIN_MAP[toChain] || parseInt(toChain);
    const fromTokenAddr = resolveToken(fromToken, fromChainId);
    const toTokenAddr = resolveToken(toToken, toChainId);

    if (!fromTokenAddr) throw new Error(`Unknown token: ${fromToken} on ${fromChain}`);
    if (!toTokenAddr || toTokenAddr === 'placeholder') throw new Error(`Unknown/placeholder token: ${toToken} on ${toChain}`);

    // Determine decimals (USDC=6, most others=18)
    const decimals = fromToken.toUpperCase().includes('USDC') ? 6 : 18;
    const fromAmount = parseUnits(amount, decimals).toString();

    console.log(`[LiFi] Quote: ${amount} ${fromToken} (${fromChain}) → ${toToken} (${toChain})`);

    const quote = await lifiGetQuote({
      fromChain: fromChainId,
      toChain: toChainId,
      fromToken: fromTokenAddr,
      toToken: toTokenAddr,
      fromAmount,
      fromAddress: userAddress || SESSION_MANAGER_V2,
    });

    return {
      quote,
      fromChainId,
      toChainId,
      fromAmount,
      estimatedOutput: quote.estimate?.toAmount || '0',
      estimatedOutputFormatted: quote.estimate?.toAmountMin ? formatUnits(BigInt(quote.estimate.toAmountMin), quote.action?.toToken?.decimals || 18) : '?',
      tool: quote.toolDetails?.name || 'lifi',
      transactionRequest: quote.transactionRequest,
    };
  }

  return {
    lifiSwap,
    get isReady() { return lifiReady; },
    LIFI_DIAMOND,
    SESSION_MANAGER_V2,
  };
}

export function registerLiFiRoutes(app, lifi) {
  const { lifiSwap, LIFI_DIAMOND, SESSION_MANAGER_V2 } = lifi;

  app.post('/api/lifi-swap', async (req, res) => {
    const { from_chain, to_chain, from_token, to_token, amount } = req.body;
    if (!from_chain || !to_chain || !from_token || !to_token || !amount) {
      return res.status(400).json({ error: 'Missing required fields: from_chain, to_chain, from_token, to_token, amount' });
    }

    try {
      const result = await lifiSwap({ fromChain: from_chain, toChain: to_chain, fromToken: from_token, toToken: to_token, amount });

      // Return quote info (actual execution will go through SessionManager V2)
      res.json({
        status: 'quoted',
        from: `${amount} ${from_token} (${from_chain})`,
        to: `~${result.estimatedOutputFormatted} ${to_token} (${to_chain})`,
        tool: result.tool,
        estimated_output: result.estimatedOutputFormatted,
        lifi_target: result.transactionRequest?.to || LIFI_DIAMOND,
        session_manager: SESSION_MANAGER_V2,
        note: 'Execution goes through SessionManagerV2.executeCall() with budget constraints',
      });
    } catch (err) {
      console.error('[LiFi] Swap error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/lifi-quote', async (req, res) => {
    const { from_chain, to_chain, from_token, to_token, amount } = req.query;
    if (!from_chain || !to_chain || !from_token || !to_token || !amount) {
      return res.status(400).json({ error: 'Missing query params' });
    }
    try {
      const result = await lifiSwap({ fromChain: from_chain, toChain: to_chain, fromToken: from_token, toToken: to_token, amount: String(amount) });
      res.json({
        from: `${amount} ${from_token} (${from_chain})`,
        to: `~${result.estimatedOutputFormatted} ${to_token} (${to_chain})`,
        tool: result.tool,
        fromChainId: result.fromChainId,
        toChainId: result.toChainId,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
