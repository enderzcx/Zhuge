import { readFileSync } from 'fs';

export function createConfig() {
  // --- Env ---
  const envLines = readFileSync('.env', 'utf-8').split('\n');
  for (const line of envLines) {
    const [k, ...v] = line.split('=');
    if (k && v.length) process.env[k.trim()] = v.join('=').trim();
  }

  const PORT = process.env.PORT || 3200;
  const CRUCIX = process.env.CRUCIX_URL || 'http://localhost:3117';
  const LLM_BASE = process.env.LLM_BASE_URL || 'http://localhost:8080/v1';
  const LLM_MODEL = process.env.LLM_MODEL || 'gpt-5.4-mini';
  const LLM_KEY = process.env.LLM_API_KEY || '';
  const NEWS_TOKEN = process.env.OPENNEWS_TOKEN;
  const NEWS_API = 'https://ai.6551.io';
  const AUTO_TRADE_URL = process.env.AUTO_TRADE_URL || '';
  if (!process.env.AUTO_TRADE_SECRET) console.warn('[Config] WARNING: AUTO_TRADE_SECRET not set in .env');
  const AUTO_TRADE_SECRET = process.env.AUTO_TRADE_SECRET || '';

  // --- Bitget CEX ---
  const BITGET_API_KEY = process.env.BITGET_API_KEY || '';
  const BITGET_SECRET = process.env.BITGET_SECRET_KEY || '';
  const BITGET_PASS = process.env.BITGET_PASSPHRASE || '';
  const BITGET_BASE = 'https://api.bitget.com';

  // Per-agent model allocation
  const AGENT_MODELS = {
    analyst:    process.env.LLM_MODEL_ANALYST    || 'gpt-5.4-mini',
    risk:       process.env.LLM_MODEL_RISK       || 'gpt-5.4-mini',
    strategist: process.env.LLM_MODEL_STRATEGIST || 'gpt-5.4-mini',
    executor:   process.env.LLM_MODEL_EXECUTOR   || 'gpt-5.4-mini-low-fast',
    reviewer:   process.env.LLM_MODEL_REVIEWER   || 'gpt-5.4-mini',
    researcher: process.env.LLM_MODEL_RESEARCHER || 'gpt-5.4-mini',
  };

  // --- LiFi Cross-Chain ---
  const LIFI_DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';
  const SESSION_MANAGER_V2 = '0x342168e8D2BF8315BbF72F409A94f1EC7570f611';

  const CHAIN_MAP = { base: 8453, ethereum: 1, bsc: 56 };
  const CHAIN_OBJECTS = { 8453: 'base', 1: 'mainnet', 56: 'bsc' };

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

  const SM_V2_ABI = [
    { type: 'function', name: 'executeCall', inputs: [{ name: 'user', type: 'address' }, { name: 'target', type: 'address' }, { name: 'spendAmount', type: 'uint256' }, { name: 'data', type: 'bytes' }], outputs: [{ name: 'result', type: 'bytes' }], stateMutability: 'nonpayable' },
    { type: 'function', name: 'canExecute', inputs: [{ name: 'user', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: 'ok', type: 'bool' }, { name: 'reason', type: 'string' }], stateMutability: 'view' },
    { type: 'function', name: 'isAllowedTarget', inputs: [{ name: 'target', type: 'address' }], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  ];

  // Telegram
  const SP_BOT_TOKEN = process.env.SP_TELEGRAM_BOT_TOKEN || '';
  const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || SP_BOT_TOKEN; // agent bot (fallback to SP)
  const TG_CHAT_ID = process.env.TG_CHAT_ID || '';               // owner chat ID for auth
  const TG_DASHBOARD_CHAT = process.env.TG_DASHBOARD_CHAT || ''; // supergroup for dashboard (optional)
  const TG_TOPIC_POSITIONS = process.env.TG_TOPIC_POSITIONS || '';
  const TG_TOPIC_OBSERVE = process.env.TG_TOPIC_OBSERVE || '';
  const TG_TOPIC_COMPOUND = process.env.TG_TOPIC_COMPOUND || '';
  const TG_TOPIC_CHART = process.env.TG_TOPIC_CHART || '';
  const TG_TOPIC_NEWS = process.env.TG_TOPIC_NEWS || '';

  // Primary Market (Base V3)
  const BASE_WS_RPC = process.env.BASE_WS_RPC || ''; // wss://base-mainnet.g.alchemy.com/v2/YOUR_KEY

  const PRICE_PAIRS = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'];
  const ANOMALY_THRESHOLD = 0.02;  // 2% in 5min → instant analysis
  const FLASH_THRESHOLD = 0.05;    // 5% in 5min → FLASH alert
  const PRICE_WINDOW = 5 * 60 * 1000; // 5 min
  const PATROL_INTERVAL = 12; // 12 * 15min = 3h
  const WEEKLY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

  // --- Graduated Position Scaling ---
  const SCALING = {
    enabled: true,
    ratios: [1, 1, 2, 4],                          // L0:L1:L2:L3 = 1:1:2:4 (total 8 parts)
    confidence_thresholds: [55, 60, 70, 80],        // min confidence per level
    price_confirm_pcts: [0, 0.003, 0.006, 0.01],     // cumulative price move as fraction (0.3%, 0.6%, 1.0%)
    action_requirements: [
      ['increase_exposure', 'strong_buy', 'strong_sell'],                     // L0: directional (no reduce_exposure — contradicts opening new position)
      ['increase_exposure', 'strong_buy', 'strong_sell'],                     // L1: directional
      ['strong_buy', 'strong_sell'],                                          // L2: strong only
      ['strong_buy', 'strong_sell'],                                          // L3: strong only
    ],
    stop_loss_pcts: [3.0, 2.5, 2.0, 1.5],           // SL % from avg entry per level (tightens)
    max_exposure_eth: 1.0,                           // hard cap total position
    max_exposure_pct: 0.30,                          // max % of account equity
    abandon_cooldown_ms: 30 * 60 * 1000,             // 30 min cooldown after abandon
    symbols: ['ETHUSDT', 'BTCUSDT', 'SOLUSDT'],     // tradable symbols
  };

  // --- Momentum: New Coin Research & Trading ---
  const MOMENTUM = {
    enabled: true,
    max_open: 2,                             // max simultaneous momentum trades
    margin_per_trade: 2.5,                   // USDT margin per trade
    leverage: 10,
    min_score: 60,                           // minimum research score to trade (lowered for momentum strategy)
    volume_threshold: 1_000_000,             // $1M min 24h volume
    change_threshold: 0.05,                  // 5% min 24h change for "trending"
    max_daily_loss: 5,                       // USDT, pause if exceeded
    exclude_symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    coingecko_api: 'https://api.coingecko.com/api/v3',
  };

  return {
    PORT, CRUCIX, LLM_BASE, LLM_MODEL, LLM_KEY, NEWS_TOKEN, NEWS_API,
    AUTO_TRADE_URL, AUTO_TRADE_SECRET,
    BITGET_API_KEY, BITGET_SECRET, BITGET_PASS, BITGET_BASE,
    AGENT_MODELS, SCALING, MOMENTUM,
    LIFI_DIAMOND, SESSION_MANAGER_V2, CHAIN_MAP, CHAIN_OBJECTS, TOKEN_REGISTRY, SM_V2_ABI,
    PRICE_PAIRS, ANOMALY_THRESHOLD, FLASH_THRESHOLD, PRICE_WINDOW,
    PATROL_INTERVAL, WEEKLY_INTERVAL_MS,
    SP_BOT_TOKEN, TG_BOT_TOKEN, TG_CHAT_ID,
    TG_DASHBOARD_CHAT, TG_TOPIC_POSITIONS, TG_TOPIC_OBSERVE, TG_TOPIC_COMPOUND, TG_TOPIC_CHART, TG_TOPIC_NEWS,
    BASE_WS_RPC,
  };
}
