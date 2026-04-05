/**
 * Data tools — market data queries via TG agent.
 *   crucix_data, fetch_news, market_scan, price, agent_decisions
 */

export function createDataTools({ dataSources, priceStream, db, scanner }) {
  const { fetchCrucix, fetchNews, compactCrucixObj } = dataSources;
  const { priceCache } = priceStream;

  const TOOL_DEFS = [
    {
      name: 'crucix_data',
      description: 'Crucix 27源 OSINT 数据 (VIX, BTC, 黄金, 地缘, 天气, TG urgent 等)',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '查特定 key (可选, 不填返回全部摘要)' },
        },
      },
      requiresConfirmation: false,
    },
    {
      name: 'fetch_news',
      description: 'AI 评分加密/金融新闻 (含情绪信号 long/short/neutral)',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '新闻条数 (默认10, 最多15)' },
        },
      },
      requiresConfirmation: false,
    },
    {
      name: 'market_scan',
      description: 'Bitget 全市场扫描 — 540+ futures 中筛选高波动/高成交标的',
      parameters: { type: 'object', properties: {}, required: [] },
      requiresConfirmation: false,
    },
    {
      name: 'price',
      description: '实时价格 (BTC/ETH/SOL via OKX WebSocket, 含5分钟变化)',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: '交易对 (如 BTC-USDT, 不填返回全部)' },
        },
      },
      requiresConfirmation: false,
    },
    {
      name: 'agent_decisions',
      description: '查看最近 N 条 AI 决策记录 (analyst/risk/trade)',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '条数 (默认10)' },
          agent: { type: 'string', description: '按 agent 筛选 (analyst/risk/reviewer)' },
        },
      },
      requiresConfirmation: false,
    },
  ];

  const EXECUTORS = {
    async crucix_data({ key } = {}) {
      try {
        const data = await fetchCrucix();
        if (!data) return '{ "error": "Crucix unavailable" }';
        if (key) {
          const val = data[key];
          return val ? JSON.stringify(val) : `Key "${key}" not found. Available: ${Object.keys(data).slice(0, 20).join(', ')}`;
        }
        return JSON.stringify(compactCrucixObj ? compactCrucixObj(data) : data);
      } catch (err) {
        return `{ "error": "${err.message}" }`;
      }
    },

    async fetch_news({ limit } = {}) {
      try {
        const news = await fetchNews();
        if (!news || !Array.isArray(news)) return '[]';
        const items = news.slice(0, limit || 10);
        return JSON.stringify(items.map(n => ({
          title: n.title || n.headline,
          signal: n.signal || n.aiRating?.signal || 'neutral',
          score: n.score || n.aiRating?.score || 0,
          source: n.source,
          url: n.url || n.link || '',
        })));
      } catch (err) {
        return `{ "error": "${err.message}" }`;
      }
    },

    async market_scan() {
      try {
        if (!scanner) return '{ "error": "Scanner not available" }';
        const opps = await scanner.scanMarketOpportunities();
        return JSON.stringify((opps || []).slice(0, 15).map(o => ({
          symbol: o.symbol,
          price: o.lastPr,
          change24h: o.change24h,
          volume24h: o.quoteVolume24h,
          fundingRate: o.fundingRate,
        })));
      } catch (err) {
        return `{ "error": "${err.message}" }`;
      }
    },

    async price({ symbol } = {}) {
      if (!priceCache) return '{ "error": "Price stream not available" }';
      if (symbol) {
        const pair = symbol.includes('-') ? symbol : symbol.replace('USDT', '-USDT');
        const entry = priceCache[pair];
        return entry ? JSON.stringify(entry) : `No price data for ${symbol}`;
      }
      return JSON.stringify(priceCache);
    },

    async agent_decisions({ limit, agent } = {}) {
      try {
        let sql = 'SELECT timestamp, agent, action, tool_name, reasoning, confidence FROM decisions';
        const params = [];
        if (agent) { sql += ' WHERE agent = ?'; params.push(agent); }
        sql += ' ORDER BY timestamp DESC LIMIT ?';
        params.push(limit || 10);
        const rows = db.prepare(sql).all(...params);
        return JSON.stringify(rows.map(r => ({
          ...r,
          reasoning: (r.reasoning || '').slice(0, 200),
        })));
      } catch (err) {
        return `{ "error": "${err.message}" }`;
      }
    },
  };

  return { TOOL_DEFS, EXECUTORS };
}
