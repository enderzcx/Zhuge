/**
 * TradingView tools — market data via local TradingView MCP server.
 *   tv_market_snapshot, tv_coin_analysis, tv_multi_timeframe,
 *   tv_top_gainers, tv_top_losers, tv_volume_breakout, tv_smart_volume,
 *   tv_bollinger_scan, tv_backtest, tv_compare_strategies,
 *   tv_sentiment, tv_news
 */

const MCP_URL = 'http://127.0.0.1:8200/mcp';
const TIMEOUT = 30_000;
let sessionId = null;
let sessionPromise = null;
let rpcId = 0;

// --- MCP streamable-http client ---

async function mcpCall(method, params) {
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const sentId = ++rpcId;
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: sentId, method, params }),
    signal: AbortSignal.timeout(TIMEOUT),
  });

  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;

  if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  if (data.id !== sentId) throw new Error(`MCP response id mismatch: sent ${sentId}, got ${data.id}`);
  return data.result;
}

async function ensureSession() {
  if (sessionId) return;
  // Promise-based lock: concurrent callers share one init attempt
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    await mcpCall('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'zhuge', version: '1.0' },
    });
    // Send initialized notification (required by MCP spec)
    await fetch(MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'mcp-session-id': sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  })();
  try { await sessionPromise; } finally { sessionPromise = null; }
}

async function callTool(name, args = {}) {
  try {
    await ensureSession();
    const result = await mcpCall('tools/call', { name, arguments: args });
    // MCP tools/call returns { content: [{ type, text }] }
    if (result?.content?.[0]?.text) return result.content[0].text;
    return JSON.stringify(result);
  } catch (err) {
    // Always reset session on error — cheap to re-initialize
    sessionId = null;
    return JSON.stringify({ error: `TradingView MCP: ${err.message}` });
  }
}

// --- Tool Definitions ---

const TOOL_DEFS = [
  {
    name: 'tv_market_snapshot',
    description: 'TradingView 全球市场概览 — BTC/ETH/SOL + 主要指数 + 黄金/原油 + FX 汇率。用来判断整体市场环境和风险偏好',
    parameters: { type: 'object', properties: {} },
    requiresConfirmation: false,
  },
  {
    name: 'tv_coin_analysis',
    description: 'TradingView 单币深度技术分析 — 30+ 指标 (RSI/MACD/BB/EMA/ADX 等)。exchange 默认 BINANCE',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '交易对 (如 BTCUSDT, ETHUSDT)' },
        exchange: { type: 'string', description: '交易所 (BINANCE/KUCOIN/BYBIT/BITGET, 默认 BINANCE)' },
        timeframe: { type: 'string', description: '时间周期 (5m/15m/1h/4h/1D/1W, 默认 15m)' },
      },
      required: ['symbol'],
    },
    requiresConfirmation: false,
  },
  {
    name: 'tv_multi_timeframe',
    description: 'TradingView 多时间框架对齐分析 (周线→日线→4H→1H→15m) — 判断趋势共振',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '交易对 (如 BTCUSDT)' },
        exchange: { type: 'string', description: '交易所 (默认 BINANCE)' },
      },
      required: ['symbol'],
    },
    requiresConfirmation: false,
  },
  {
    name: 'tv_top_gainers',
    description: 'TradingView 涨幅榜 — 指定交易所和时间周期的 top gainers',
    parameters: {
      type: 'object',
      properties: {
        exchange: { type: 'string', description: '交易所 (默认 BINANCE)' },
        timeframe: { type: 'string', description: '时间周期 (默认 15m)' },
        limit: { type: 'number', description: '数量 (默认 25)' },
      },
    },
    requiresConfirmation: false,
  },
  {
    name: 'tv_top_losers',
    description: 'TradingView 跌幅榜 — 指定交易所和时间周期的 top losers',
    parameters: {
      type: 'object',
      properties: {
        exchange: { type: 'string', description: '交易所 (默认 BINANCE)' },
        timeframe: { type: 'string', description: '时间周期 (默认 15m)' },
        limit: { type: 'number', description: '数量 (默认 25)' },
      },
    },
    requiresConfirmation: false,
  },
  {
    name: 'tv_volume_breakout',
    description: 'TradingView 放量突破扫描 — 量价齐升的标的',
    parameters: {
      type: 'object',
      properties: {
        exchange: { type: 'string', description: '交易所 (默认 BINANCE)' },
        timeframe: { type: 'string', description: '时间周期 (默认 15m)' },
        volume_multiplier: { type: 'number', description: '成交量倍数阈值 (默认 2.0)' },
        price_change_min: { type: 'number', description: '最小涨幅% (默认 3.0)' },
        limit: { type: 'number', description: '数量 (默认 25)' },
      },
    },
    requiresConfirmation: false,
  },
  {
    name: 'tv_smart_volume',
    description: 'TradingView 智能量价扫描 — 成交量 + RSI + 技术面综合筛选',
    parameters: {
      type: 'object',
      properties: {
        exchange: { type: 'string', description: '交易所 (默认 BINANCE)' },
        min_volume_ratio: { type: 'number', description: '最小成交量倍数 (默认 2.0)' },
        min_price_change: { type: 'number', description: '最小涨跌幅% (默认 2.0)' },
        rsi_range: { type: 'string', description: 'RSI 区间: oversold/overbought/any (默认 any)' },
        limit: { type: 'number', description: '数量 (默认 20)' },
      },
    },
    requiresConfirmation: false,
  },
  {
    name: 'tv_bollinger_scan',
    description: 'TradingView 布林带挤压扫描 — 低 BBW 标的 (即将爆发)',
    parameters: {
      type: 'object',
      properties: {
        exchange: { type: 'string', description: '交易所 (默认 BINANCE)' },
        timeframe: { type: 'string', description: '时间周期 (默认 4h)' },
        bbw_threshold: { type: 'number', description: 'BBW 阈值 (默认 0.04)' },
        limit: { type: 'number', description: '数量 (默认 50)' },
      },
    },
    requiresConfirmation: false,
  },
  {
    name: 'tv_backtest',
    description: 'TradingView 策略回测 — 支持 rsi/bollinger/macd/ema_cross/supertrend/donchian 六种策略',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '标的 (如 BTCUSDT)' },
        strategy: { type: 'string', description: '策略: rsi/bollinger/macd/ema_cross/supertrend/donchian' },
        period: { type: 'string', description: '回测周期 (默认 1y)' },
        interval: { type: 'string', description: 'K线周期 (默认 1d)' },
      },
      required: ['symbol', 'strategy'],
    },
    requiresConfirmation: false,
  },
  {
    name: 'tv_compare_strategies',
    description: 'TradingView 6策略对比 — 同一标的跑全部策略返回排行榜',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '标的 (如 BTCUSDT)' },
        period: { type: 'string', description: '回测周期 (默认 1y)' },
        interval: { type: 'string', description: 'K线周期 (默认 1d)' },
      },
      required: ['symbol'],
    },
    requiresConfirmation: false,
  },
  {
    name: 'tv_sentiment',
    description: 'Reddit 市场情绪分析 — 指定标的的社区情绪 (看多/看空/中性)',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '标的 (如 BTC, AAPL)' },
        category: { type: 'string', description: '分类: all/bullish/bearish (默认 all)' },
        limit: { type: 'number', description: '帖子数 (默认 20)' },
      },
      required: ['symbol'],
    },
    requiresConfirmation: false,
  },
  {
    name: 'tv_news',
    description: 'TradingView 财经新闻聚合 — Reuters/CoinDesk/CoinTelegraph 等',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '按标的筛选 (可选)' },
        category: { type: 'string', description: '分类: stocks/crypto/general (默认 crypto)' },
        limit: { type: 'number', description: '条数 (默认 10)' },
      },
    },
    requiresConfirmation: false,
  },
];

// --- Mapping: our tool name → MCP server tool name + arg transform ---

const TOOL_MAP = {
  tv_market_snapshot:    { mcpName: 'market_snapshot',            transform: () => ({}) },
  tv_coin_analysis:      { mcpName: 'coin_analysis',              transform: a => ({ symbol: a.symbol, exchange: a.exchange ?? 'BINANCE', timeframe: a.timeframe ?? '15m' }) },
  tv_multi_timeframe:    { mcpName: 'multi_timeframe_analysis',   transform: a => ({ symbol: a.symbol, exchange: a.exchange ?? 'BINANCE' }) },
  tv_top_gainers:        { mcpName: 'top_gainers',                transform: a => ({ exchange: a.exchange ?? 'BINANCE', timeframe: a.timeframe ?? '15m', limit: a.limit ?? 25 }) },
  tv_top_losers:         { mcpName: 'top_losers',                 transform: a => ({ exchange: a.exchange ?? 'BINANCE', timeframe: a.timeframe ?? '15m', limit: a.limit ?? 25 }) },
  tv_volume_breakout:    { mcpName: 'volume_breakout_scanner',    transform: a => ({ exchange: a.exchange ?? 'BINANCE', timeframe: a.timeframe ?? '15m', volume_multiplier: a.volume_multiplier ?? 2.0, price_change_min: a.price_change_min ?? 3.0, limit: a.limit ?? 25 }) },
  tv_smart_volume:       { mcpName: 'smart_volume_scanner',       transform: a => ({ exchange: a.exchange ?? 'BINANCE', min_volume_ratio: a.min_volume_ratio ?? 2.0, min_price_change: a.min_price_change ?? 2.0, rsi_range: a.rsi_range ?? 'any', limit: a.limit ?? 20 }) },
  tv_bollinger_scan:     { mcpName: 'bollinger_scan',             transform: a => ({ exchange: a.exchange ?? 'BINANCE', timeframe: a.timeframe ?? '4h', bbw_threshold: a.bbw_threshold ?? 0.04, limit: a.limit ?? 50 }) },
  tv_backtest:           { mcpName: 'backtest_strategy',          transform: a => ({ symbol: a.symbol, strategy: a.strategy, period: a.period ?? '1y', interval: a.interval ?? '1d' }) },
  tv_compare_strategies: { mcpName: 'compare_strategies',         transform: a => ({ symbol: a.symbol, period: a.period ?? '1y', interval: a.interval ?? '1d' }) },
  tv_sentiment:          { mcpName: 'market_sentiment',           transform: a => ({ symbol: a.symbol, category: a.category ?? 'all', limit: a.limit ?? 20 }) },
  tv_news:               { mcpName: 'financial_news',             transform: a => ({ symbol: a.symbol, category: a.category ?? 'crypto', limit: a.limit ?? 10 }) },
};

// --- Build executors ---

const EXECUTORS = {};
for (const [toolName, { mcpName, transform }] of Object.entries(TOOL_MAP)) {
  EXECUTORS[toolName] = async (args = {}) => callTool(mcpName, transform(args));
}

export function createTradingViewTools() {
  return { TOOL_DEFS, EXECUTORS };
}
