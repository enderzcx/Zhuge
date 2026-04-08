/**
 * Data tools — market data queries via TG agent.
 *   crucix_data, fetch_news, market_scan, price, agent_decisions,
 *   explore_codebase, query_metrics, read_logs, status_report
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

export function createDataTools({ dataSources, priceStream, db, scanner, pushEngine, compound, readLogs, rag, intelStream, config, klineMonitor }) {
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
      name: 'tg_urgent',
      description: '实时地缘政治/战争快讯 (来自 Telegram 情报频道)',
      parameters: { type: 'object', properties: {}, required: [] },
      requiresConfirmation: false,
    },
    {
      name: 'news_feed',
      description: '全球新闻摘要 (50条, 含 headline + URL + 来源 + 地区)',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '条数 (默认10)' },
          region: { type: 'string', description: '按地区筛选 (可选)' },
        },
      },
      requiresConfirmation: false,
    },
    {
      name: 'run_compound',
      description: '触发 AI 自主复盘 — 分析所有历史交易，发现 pattern，更新/新增/废弃交易规则。你觉得需要复盘时就调用（比如连续亏损、策略疑问、用户要求等）',
      parameters: { type: 'object', properties: {}, required: [] },
      requiresConfirmation: false,
    },
    {
      name: 'recent_pushes',
      description: '最近的推送记录 (含完整分析上下文, 用于追问)',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '条数 (默认5)' },
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
    {
      name: 'status_report',
      description: '一键状态报告: 持仓 + PnL + 余额 + 系统资源 + 最近错误 + compound规则',
      parameters: { type: 'object', properties: {}, required: [] },
      requiresConfirmation: false,
    },
    {
      name: 'explore_codebase',
      description: '扫描项目代码结构: 所有模块、子 agent、自动化任务、依赖。用来了解"我是谁、我控制什么"',
      parameters: { type: 'object', properties: {}, required: [] },
      requiresConfirmation: false,
    },
    {
      name: 'query_metrics',
      description: '查询可观测性指标 (系统资源/LLM延迟/API延迟/错误数等)。可聚合、过滤',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '指标名 (system_heap_mb, llm_latency_ms, bitget_api_latency_ms, error_count 等)' },
          since_hours: { type: 'number', description: '查最近 N 小时 (默认1)' },
          agg: { type: 'string', description: '聚合方式: avg, sum, count, min, max, raw (默认 avg)' },
          limit: { type: 'number', description: 'raw 模式下最多返回条数 (默认20)' },
        },
      },
      requiresConfirmation: false,
    },
    {
      name: 'read_logs',
      description: '读取结构化日志。可按级别、模块、时间过滤',
      parameters: {
        type: 'object',
        properties: {
          level: { type: 'string', description: '最低级别: debug/info/warn/error (默认 info)' },
          module: { type: 'string', description: '按模块过滤 (pipeline, scanner, momentum, bitget_exec 等)' },
          since_hours: { type: 'number', description: '查最近 N 小时 (默认1)' },
          limit: { type: 'number', description: '最多返回条数 (默认20)' },
        },
      },
      requiresConfirmation: false,
    },
    {
      name: 'search_knowledge',
      description: '搜索知识库 (交易策略/量化理论/历史案例/指标用法/风控规则)，语义检索',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索内容 (如"Wyckoff 吸筹", "funding rate 极端值", "FOMC 影响")' },
          category: { type: 'string', description: '按类别过滤: strategy/indicator/risk_rule/case/market (可选)' },
          limit: { type: 'number', description: '返回条数 (默认5)' },
        },
        required: ['query'],
      },
      requiresConfirmation: false,
    },
    {
      name: 'add_knowledge',
      description: '向知识库添加新知识 (交易经验、策略笔记、市场规律)',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '标题' },
          content: { type: 'string', description: '内容 (100-500字)' },
          category: { type: 'string', description: '类别: strategy/indicator/risk_rule/case/market' },
          tags: { type: 'string', description: '逗号分隔标签 (可选)' },
        },
        required: ['title', 'content', 'category'],
      },
      requiresConfirmation: true,
    },
    {
      name: 'list_compound_strategies',
      description: 'AI 生成的交易策略列表 (proposed/active/retired 状态)',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: '状态筛选: active/proposed/retired/all (默认 active)' },
        },
      },
      requiresConfirmation: false,
    },
    {
      name: 'strategy_performance',
      description: '查看某个 AI 策略的历史表现和交易明细',
      parameters: {
        type: 'object',
        properties: {
          strategy_id: { type: 'string', description: '策略 ID' },
        },
        required: ['strategy_id'],
      },
      requiresConfirmation: false,
    },
    {
      name: 'run_backtest',
      description: '对 AI 策略进行历史回测。用 Bitget 历史 K 线数据验证策略表现（胜率/PnL/回撤）。不用 LLM，纯确定性回放。',
      parameters: {
        type: 'object',
        properties: {
          strategy_id: { type: 'string', description: '要回测的 compound strategy ID' },
          symbol: { type: 'string', description: '交易对 (默认 BTCUSDT)' },
          days: { type: 'number', description: '回测天数 (默认 30)' },
          timeframe: { type: 'string', description: '时间框架 (默认 1H)' },
        },
        required: ['strategy_id'],
      },
      requiresConfirmation: false,
    },
    // --- Intel Stream tools ---
    {
      name: 'search_twitter',
      description: 'Twitter/X 搜索: 关键词搜推文，含点赞/转发/KOL 信息。用于判断市场情绪、重大事件社交反应',
      parameters: {
        type: 'object',
        properties: {
          keywords: { type: 'string', description: '搜索关键词 (如 "BTC crash", "SEC crypto")' },
          max_results: { type: 'number', description: '返回条数 (默认10, 最多20)' },
        },
        required: ['keywords'],
      },
      requiresConfirmation: false,
    },
    {
      name: 'get_kol_tweets',
      description: '获取指定 Twitter KOL 最新推文。常用 KOL: whale_alert, lookonchain, EmberCN, DeItaone, tier10k',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'Twitter 用户名 (不含@)' },
          max_results: { type: 'number', description: '返回条数 (默认5, 最多10)' },
        },
        required: ['username'],
      },
      requiresConfirmation: false,
    },
    {
      name: 'get_fear_greed',
      description: '加密货币恐慌贪婪指数 (0=极度恐慌, 100=极度贪婪)。用于宏观情绪判断',
      parameters: { type: 'object', properties: {}, required: [] },
      requiresConfirmation: false,
    },
    {
      name: 'search_news',
      description: '搜索加密新闻: 关键词搜索72+来源(Bloomberg/Reuters/CoinDesk等)，含AI评分和信号。用于验证消息、追踪事件、查特定币种新闻',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜索关键词 (如 "SEC ETF", "Binance hack")' },
          coin: { type: 'string', description: '按币种过滤 (如 "BTC", "ETH", "SOL")' },
          limit: { type: 'number', description: '返回条数 (默认10, 最多20)' },
        },
      },
      requiresConfirmation: false,
    },
    {
      name: 'get_listing_news',
      description: '交易所上币/下币公告 (Binance/Coinbase/OKX/Bybit)。重大上币=利好，下币=利空',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '返回条数 (默认10)' },
        },
      },
      requiresConfirmation: false,
    },
    {
      name: 'get_onchain_signals',
      description: '链上信号: 鲸鱼交易、KOL操作、大额持仓变动 (Hyperliquid等)。用于验证鲸鱼动向',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '返回条数 (默认10)' },
        },
      },
      requiresConfirmation: false,
    },
    {
      name: 'get_high_impact_news',
      description: '高影响力新闻 (AI评分≥70)。只看最重要的新闻，过滤噪音',
      parameters: {
        type: 'object',
        properties: {
          min_score: { type: 'number', description: 'AI最低评分 (默认70, 范围0-100)' },
          signal: { type: 'string', description: '过滤信号方向: long/short/neutral (可选)' },
          limit: { type: 'number', description: '返回条数 (默认10)' },
        },
      },
      requiresConfirmation: false,
    },
    {
      name: 'get_intel_feed',
      description: '实时情报流: TG频道+API 合并的最新市场情报，含 impact 评分和来源。用于快速了解当前市场发生了什么',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '返回条数 (默认15)' },
        },
      },
      requiresConfirmation: false,
    },
    // --- K-line Monitor tools ---
    {
      name: 'kline_subscribe',
      description: '订阅一个币种的实时K线监控 — 自动计算 5m/15m/1h 技术指标并检测信号。格式: XXX-USDT',
      parameters: {
        type: 'object',
        properties: {
          pair: { type: 'string', description: '交易对 (如 JOE-USDT, ZEC-USDT)' },
        },
        required: ['pair'],
      },
      requiresConfirmation: false,
    },
    {
      name: 'kline_unsubscribe',
      description: '取消订阅某个币种的K线监控（BTC/ETH/SOL 不可取消）',
      parameters: {
        type: 'object',
        properties: {
          pair: { type: 'string', description: '交易对 (如 JOE-USDT)' },
        },
        required: ['pair'],
      },
      requiresConfirmation: false,
    },
    {
      name: 'kline_status',
      description: '查看当前所有K线监控状态 — 包含每个币种的蜡烛数量、最新RSI/EMA/MACD等',
      parameters: { type: 'object', properties: {} },
      requiresConfirmation: false,
    },
    {
      name: 'kline_indicators',
      description: '获取指定币种的最新技术指标快照（实时计算，不需要调外部API）',
      parameters: {
        type: 'object',
        properties: {
          pair: { type: 'string', description: '交易对 (如 BTC-USDT)' },
          timeframe: { type: 'string', description: '时间周期: 5m/15m/1h (默认 5m)' },
        },
        required: ['pair'],
      },
      requiresConfirmation: false,
    },
  ];

  // --- OpenTwitter API helper ---
  const TWITTER_API = 'https://ai.6551.io/open';
  async function _twitterPost(endpoint, body) {
    const token = config?.TWITTER_TOKEN || process.env.TWITTER_TOKEN;
    if (!token) return { error: 'TWITTER_TOKEN not configured' };
    const res = await fetch(`${TWITTER_API}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { error: `Twitter API ${res.status}` };
    return res.json();
  }

  const EXECUTORS = {
    async run_backtest({ strategy_id, symbol = 'BTCUSDT', days = 30, timeframe = '1H' } = {}) {
      if (!strategy_id) return JSON.stringify({ error: 'strategy_id required' });
      try {
        const { loadCandles, candleCount } = await import('../../backtest/loader.mjs');
        const { loadMarketStateHistory } = await import('../../backtest/market-state-loader.mjs');
        const { runBacktest } = await import('../../backtest/engine.mjs');
        const rawDb = db.db || db;

        // Check if we have enough data, auto-load if not
        const existing = candleCount(rawDb, symbol, timeframe);
        const endTs = Date.now();
        const startTs = endTs - days * 86400000;
        if (existing.count < days * 24) {
          await loadCandles(rawDb, symbol, timeframe, startTs, endTs);
        }
        await loadMarketStateHistory(rawDb, symbol, timeframe, startTs, endTs);

        const result = runBacktest({ db: rawDb, symbol, timeframe, strategyId: strategy_id, startTs, endTs });
        return JSON.stringify({
          strategy_id, symbol, timeframe, days,
          candles: result.candleCount,
          stats: result.stats,
          time_stop_count: result.time_stop_count,
          partial_fill_count: result.partial_fill_count,
          target_changes: result.target_changes,
          ladder_order_count: result.ladder_order_count,
          report: result.report,
          trades_sample: result.trades.slice(-5).map(t => ({
            side: t.side, entry: t.entryPrice, exit: t.exitPrice, pnl: t.pnl?.toFixed(2), reason: t.reason,
          })),
        });
      } catch (err) {
        return JSON.stringify({ error: err.message });
      }
    },

    async list_compound_strategies({ status } = {}) {
      try {
        const filter = status === 'all' ? '' : `WHERE status = '${status || 'active'}'`;
        const rows = db.prepare(`SELECT strategy_id, name, direction, symbols, confidence, status, evidence_json, created_at FROM compound_strategies ${filter} ORDER BY confidence DESC LIMIT 10`).all();
        return JSON.stringify(rows.map(r => ({
          ...r,
          symbols: JSON.parse(r.symbols || '[]'),
          evidence: JSON.parse(r.evidence_json || '{}'),
        })));
      } catch (err) {
        return JSON.stringify({ error: err.message });
      }
    },

    async strategy_performance({ strategy_id } = {}) {
      if (!strategy_id) return JSON.stringify({ error: 'strategy_id required' });
      try {
        const strategy = db.prepare('SELECT * FROM compound_strategies WHERE strategy_id = ?').get(strategy_id);
        if (!strategy) return JSON.stringify({ error: 'Strategy not found' });
        const trades = db.prepare("SELECT trade_id, pair, side, entry_price, exit_price, pnl, pnl_pct, opened_at, closed_at FROM trades WHERE strategy_id = ? ORDER BY opened_at DESC LIMIT 20").all(strategy_id);
        return JSON.stringify({
          strategy: { ...strategy, symbols: JSON.parse(strategy.symbols || '[]'), evidence: JSON.parse(strategy.evidence_json || '{}'), entry_conditions: JSON.parse(strategy.entry_conditions || '[]'), exit_conditions: JSON.parse(strategy.exit_conditions || '[]') },
          trades,
        });
      } catch (err) {
        return JSON.stringify({ error: err.message });
      }
    },

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
        return JSON.stringify({ error: err.message });
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
        return JSON.stringify({ error: err.message });
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
        return JSON.stringify({ error: err.message });
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

    async tg_urgent() {
      try {
        const crucix = await fetchCrucix();
        const urgent = crucix?.tg?.urgent || [];
        if (urgent.length === 0) return '当前无紧急快讯';
        return urgent.slice(0, 10).map(u =>
          `[${u.channel || '?'}] ${(u.text || '').slice(0, 200)}`
        ).join('\n\n');
      } catch (err) {
        return JSON.stringify({ error: err.message });
      }
    },

    async news_feed({ limit, region } = {}) {
      try {
        const crucix = await fetchCrucix();
        const feed = crucix?.newsFeed || [];
        let items = feed.filter(n => n.headline || n.title);
        if (region) items = items.filter(n => (n.region || '').toLowerCase().includes(region.toLowerCase()));
        return JSON.stringify(items.slice(0, limit || 10).map(n => ({
          headline: n.headline || n.title,
          source: n.source,
          region: n.region,
          url: n.url || '',
          urgent: n.urgent || false,
        })));
      } catch (err) {
        return JSON.stringify({ error: err.message });
      }
    },

    async run_compound() {
      if (!compound) return '{ "error": "compound module not available" }';
      try {
        const result = await compound.run();
        if (!result) return '没有足够的新交易数据需要复盘';
        return JSON.stringify({
          trades_reviewed: result.trades,
          rules_generated: result.generated,
          rules_updated: result.updated,
          rules_deprecated: result.deprecated,
          summary: result.summary || 'done',
        });
      } catch (err) {
        return JSON.stringify({ error: err.message });
      }
    },

    async recent_pushes({ limit } = {}) {
      if (!pushEngine) return '[]';
      const contexts = pushEngine.getRecentContext(limit || 5);
      return JSON.stringify(contexts.map(c => ({
        level: c.level,
        text: c.text,
        pushedAt: c.pushedAt,
        analysis: c.context?.analysis ? {
          action: c.context.analysis.recommended_action,
          confidence: c.context.analysis.confidence,
          briefing: c.context.analysis.briefing,
          alerts: c.context.analysis.alerts,
        } : null,
        news: (c.context?.news || []).slice(0, 3),
      })));
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
        return JSON.stringify({ error: err.message });
      }
    },

    async status_report() {
      const parts = [];
      try {
        // 1. Positions
        const openTrades = db.prepare("SELECT pair, side, leverage, entry_price, amount, pnl FROM trades WHERE status = 'open'").all();
        if (openTrades.length > 0) {
          const posLines = openTrades.map(t => `  ${t.pair} ${t.side} ${t.leverage}x @ ${t.entry_price}`);
          parts.push(`持仓 (${openTrades.length}):\n${posLines.join('\n')}`);
        } else {
          parts.push('持仓: 无');
        }

        // 2. PnL summary
        const stats = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins, COALESCE(SUM(pnl), 0) as total_pnl FROM trades WHERE status = 'closed' AND pnl != 0").get();
        const winRate = stats.total > 0 ? ((stats.wins / stats.total) * 100).toFixed(0) : '0';
        parts.push(`PnL: ${stats.total_pnl?.toFixed(2) || 0} USDT | 胜率: ${winRate}% (${stats.wins}/${stats.total})`);

        // 3. System resources
        const heap = process.memoryUsage();
        const os = await import('os');
        const upH = (process.uptime() / 3600).toFixed(1);
        parts.push(`系统: Heap ${Math.round(heap.heapUsed / 1024 / 1024)}MB | RSS ${Math.round(heap.rss / 1024 / 1024)}MB | Mem ${Math.round((1 - os.freemem() / os.totalmem()) * 100)}% | Uptime ${upH}h`);

        // 4. Recent errors (last 1h)
        const h1 = Date.now() - 3600000;
        const errors = db.prepare("SELECT COALESCE(SUM(value), 0) as cnt FROM metrics WHERE name = 'error_count' AND ts > ?").get(h1);
        parts.push(`错误 (1h): ${errors.cnt || 0}`);

        // 5. LLM stats (last 1h)
        const llm = db.prepare("SELECT COUNT(*) as cnt, COALESCE(AVG(value), 0) as avg FROM metrics WHERE name = 'llm_latency_ms' AND ts > ?").get(h1);
        parts.push(`LLM (1h): ${llm.cnt} 次, 平均 ${Math.round(llm.avg)}ms`);

        // 6. Active compound rules
        try {
          const rules = db.prepare("SELECT description, confidence FROM compound_rules WHERE status = 'active' ORDER BY confidence DESC LIMIT 3").all();
          if (rules.length > 0) {
            const ruleLines = rules.map(r => `  ${(r.confidence * 100).toFixed(0)}% ${r.description.slice(0, 60)}`);
            parts.push(`Compound 规则 (${rules.length}):\n${ruleLines.join('\n')}`);
          }
        } catch {}

        return parts.join('\n\n');
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },

    async explore_codebase() {
      try {
        const root = process.cwd();
        const parts = [];

        // Only scan meaningful directories (skip stockpulse/, routes/, tests/, integrations/)
        const SCAN_DIRS = ['agent', 'agents', 'bitget', 'market'];
        const SCAN_ROOT_FILES = ['index.mjs', 'pipeline.mjs', 'config.mjs', 'db.mjs'];

        // 1. Read key files with first-line descriptions
        const fileDescs = [];
        function getDesc(filePath) {
          try {
            const content = readFileSync(filePath, 'utf-8');
            const lines = content.split('\n').length;
            // Extract first JSDoc comment line or first non-empty line
            const match = content.match(/\/\*\*?\s*\n?\s*\*?\s*(.+?)[\n*]/);
            const desc = match?.[1]?.trim() || '';
            return { lines, desc };
          } catch { return { lines: 0, desc: '' }; }
        }

        // Root files
        for (const f of SCAN_ROOT_FILES) {
          const info = getDesc(join(root, f));
          fileDescs.push(`  ${f} (${info.lines}行) — ${info.desc}`);
        }

        // Scan directories
        for (const dir of SCAN_DIRS) {
          try {
            const dirPath = join(root, dir);
            const files = [];
            function walk(d, prefix) {
              for (const f of readdirSync(d)) {
                const full = join(d, f);
                const stat = statSync(full);
                if (stat.isDirectory()) walk(full, prefix + f + '/');
                else if (f.endsWith('.mjs')) {
                  const info = getDesc(full);
                  files.push(`  ${prefix}${f} (${info.lines}行) — ${info.desc}`);
                }
              }
            }
            walk(dirPath, dir + '/');
            fileDescs.push(`\n[${dir}/]`);
            fileDescs.push(...files);
          } catch {}
        }

        const totalFiles = fileDescs.filter(f => f.includes('行')).length;
        parts.push(`代码结构 (${totalFiles}个核心文件):\n${fileDescs.join('\n')}`);

        // 2. Sub-agents with actual role descriptions (read from system prompts)
        const agentRoles = [];
        const agentDir = join(root, 'agents');
        for (const f of readdirSync(agentDir).filter(f => f.endsWith('.mjs'))) {
          try {
            const content = readFileSync(join(agentDir, f), 'utf-8');
            // Extract system prompt role line (usually "You are a ...")
            const roleMatch = content.match(/You are (?:a |an |the )?(.+?)[\.\n"'`]/i);
            const role = roleMatch?.[1]?.slice(0, 80) || f;
            agentRoles.push(`  ${f.replace('.mjs', '')}: ${role}`);
          } catch {}
        }
        parts.push(`你的下属 AI Agent (后台自动运行，你是总指挥):\n${agentRoles.join('\n')}\n\n用 agent_decisions 查看它们的决策，query_metrics 监控表现`);

        // 3. Automation (read actual intervals from config/pipeline)
        parts.push(`自动化流水线 (后台运行，不需要你触发):
  pipeline: 每30分钟 → 采集数据 → analyst分析 → risk审核 → 自动交易/否决
  scanner: 每30分钟 → 扫描540+合约 → researcher评分 → 自动开仓
  trade_sync: 每5分钟 → 同步订单/止损/持仓
  dashboard: positions每5min, observe每2h, PnL图每6h, 新闻每1h
  health: 每60秒采集 → 超阈值自动告警到TG
  compound: 每10笔关仓 → LLM自主复盘 → 写规则 → 注入下次决策`);

        // 4. PM2 processes
        try {
          const { execSync } = await import('child_process');
          const pm2 = execSync('pm2 jlist', { encoding: 'utf-8', timeout: 5000 });
          const procs = JSON.parse(pm2).map(p => `  ${p.name}: ${p.pm2_env.status} | mem:${Math.round(p.monit.memory / 1024 / 1024)}MB | uptime:${Math.round((Date.now() - p.pm2_env.pm_uptime) / 3600000)}h`);
          parts.push(`PM2 进程:\n${procs.join('\n')}`);
        } catch {}

        // 5. Skipped directories (agent should know these exist but aren't core)
        parts.push(`跳过的目录 (非核心): stockpulse/ (废弃), routes/ (HTTP API), tests/, integrations/lifi.mjs (未启用)`);

        return parts.join('\n\n');
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },

    async query_metrics({ name, since_hours, agg, limit } = {}) {
      try {
        if (!name) {
          // List all metric names with counts
          const names = db.prepare('SELECT name, COUNT(*) as cnt FROM metrics GROUP BY name ORDER BY cnt DESC').all();
          return names.map(n => `${n.name}: ${n.cnt} records`).join('\n');
        }
        const since = Date.now() - (since_hours || 1) * 3600000;
        const mode = agg || 'avg';

        if (mode === 'raw') {
          const rows = db.prepare('SELECT ts, value, tags FROM metrics WHERE name = ? AND ts > ? ORDER BY ts DESC LIMIT ?')
            .all(name, since, limit || 20);
          return JSON.stringify(rows.map(r => ({ ts: new Date(r.ts).toISOString(), value: r.value, tags: r.tags })));
        }

        const aggMap = { avg: 'AVG(value)', sum: 'SUM(value)', count: 'COUNT(*)', min: 'MIN(value)', max: 'MAX(value)' };
        const fn = aggMap[mode] || 'AVG(value)';
        const row = db.prepare(`SELECT ${fn} as result, COUNT(*) as cnt FROM metrics WHERE name = ? AND ts > ?`).get(name, since);
        return `${name} (${mode}, ${since_hours || 1}h): ${typeof row.result === 'number' ? row.result.toFixed(2) : row.result} (${row.cnt} samples)`;
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },

    async read_logs({ level, module, since_hours, limit: maxLines } = {}) {
      try {
        if (readLogs) {
          const since = new Date(Date.now() - (since_hours || 1) * 3600000).toISOString();
          const entries = readLogs({ limit: maxLines || 20, level: level || 'info', module, since });
          return entries.map(e => `[${e.ts?.split('T')[1]?.slice(0, 8) || '?'}] ${e.level} ${e.event} ${e.module ? '(' + e.module + ')' : ''} ${e.error || ''}`).join('\n');
        }
        // Fallback: read log file directly
        const logDir = join(process.cwd(), 'data', 'logs');
        const files = readdirSync(logDir).filter(f => f.endsWith('.jsonl')).sort().reverse();
        if (!files.length) return 'No log files found';
        const lines = readFileSync(join(logDir, files[0]), 'utf-8').trim().split('\n').slice(-(maxLines || 20));
        const parsed = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
        const minLevel = LEVELS[level || 'info'] || 1;
        const filtered = parsed.filter(e => {
          if (module && e.module !== module) return false;
          if ((LEVELS[e.level] || 0) < minLevel) return false;
          return true;
        });
        return filtered.map(e => `[${e.ts?.split('T')[1]?.slice(0, 8) || '?'}] ${e.level} ${e.event} ${e.module ? '(' + e.module + ')' : ''} ${e.error || ''}`).join('\n') || 'No matching logs';
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },

    async search_knowledge({ query, category, limit } = {}) {
      if (!rag) return '{ "error": "Knowledge base not initialized" }';
      if (!query) return '{ "error": "query required" }';
      try {
        const results = await rag.search(query, { limit: limit || 5, category });
        if (results.length === 0) return `No results for "${query}"`;
        return results.map(r =>
          `[${r.category}] ${r.title} (score:${r.score})\n${r.content.slice(0, 300)}`
        ).join('\n\n---\n\n');
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },

    async add_knowledge({ title, content, category, tags } = {}) {
      if (!rag) return '{ "error": "Knowledge base not initialized" }';
      if (!title || !content || !category) return '{ "error": "title, content, category required" }';
      try {
        await rag.add({ title, content, category, tags: tags || '', source: 'user' });
        return `Added: "${title}" [${category}]`;
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },

    // --- OpenNews tools (ai.6551.io/open/news_search) ---
    async search_news({ keyword, coin, limit = 10 } = {}) {
      if (!keyword && !coin) return JSON.stringify({ error: 'keyword or coin required' });
      try {
        const body = { limit: Math.min(limit, 20) };
        if (keyword) body.q = keyword;
        if (coin) body.coins = [coin.toUpperCase()];
        const data = await _twitterPost('/news_search', body);
        if (data.error) return JSON.stringify(data);
        const items = (data.data || []).slice(0, 20).map(n => ({
          title: (n.text || '').slice(0, 150),
          source: n.newsType || '?',
          score: n.aiRating?.score || 0,
          signal: n.aiRating?.signal || 'neutral',
          summary: (n.aiRating?.enSummary || n.aiRating?.summary || '').slice(0, 100),
          coins: (n.coins || []).map(c => c.symbol),
          link: n.link || '',
        }));
        return JSON.stringify({ count: items.length, items });
      } catch (err) { return JSON.stringify({ error: err.message }); }
    },

    async get_listing_news({ limit = 10 } = {}) {
      try {
        const body = { limit: Math.min(limit, 20), engineTypes: { listing: [] } };
        const data = await _twitterPost('/news_search', body);
        if (data.error) return JSON.stringify(data);
        const items = (data.data || []).slice(0, 20).map(n => ({
          title: (n.text || '').slice(0, 150),
          source: n.newsType || '?',
          score: n.aiRating?.score || 0,
          signal: n.aiRating?.signal || 'neutral',
          coins: (n.coins || []).map(c => c.symbol),
        }));
        return JSON.stringify({ count: items.length, items });
      } catch (err) { return JSON.stringify({ error: err.message }); }
    },

    async get_onchain_signals({ limit = 10 } = {}) {
      try {
        const body = { limit: Math.min(limit, 20), engineTypes: { onchain: [] } };
        const data = await _twitterPost('/news_search', body);
        if (data.error) return JSON.stringify(data);
        const items = (data.data || []).slice(0, 20).map(n => ({
          title: (n.text || '').slice(0, 150),
          source: n.newsType || '?',
          score: n.aiRating?.score || 0,
          signal: n.aiRating?.signal || 'neutral',
          coins: (n.coins || []).map(c => c.symbol),
        }));
        return JSON.stringify({ count: items.length, items });
      } catch (err) { return JSON.stringify({ error: err.message }); }
    },

    async get_high_impact_news({ min_score = 70, signal, limit = 10 } = {}) {
      try {
        const body = { limit: Math.min(limit * 3, 60) }; // fetch more, filter client-side
        const data = await _twitterPost('/news_search', body);
        if (data.error) return JSON.stringify(data);
        let items = (data.data || []).filter(n => (n.aiRating?.score || 0) >= min_score);
        if (signal) items = items.filter(n => n.aiRating?.signal === signal);
        items = items.slice(0, limit).map(n => ({
          title: (n.text || '').slice(0, 150),
          source: n.newsType || '?',
          score: n.aiRating?.score || 0,
          signal: n.aiRating?.signal || 'neutral',
          summary: (n.aiRating?.enSummary || '').slice(0, 100),
          coins: (n.coins || []).map(c => c.symbol),
        }));
        return JSON.stringify({ count: items.length, items });
      } catch (err) { return JSON.stringify({ error: err.message }); }
    },

    // --- Twitter/X tools (ai.6551.io/open/twitter_*) ---
    async search_twitter({ keywords, max_results = 10 } = {}) {
      if (!keywords) return JSON.stringify({ error: 'keywords required' });
      try {
        const data = await _twitterPost('/twitter_search', {
          keywords, maxResults: Math.min(max_results, 20), product: 'Top',
        });
        if (data.error) return JSON.stringify(data);
        const tweets = (data.data || []).slice(0, 20).map(t => ({
          user: t.userScreenName || '?',
          followers: t.userFollowers || 0,
          text: (t.text || '').slice(0, 200),
          likes: t.favoriteCount || 0,
          retweets: t.retweetCount || 0,
          date: t.createdAt || '',
        }));
        return JSON.stringify({ count: tweets.length, tweets });
      } catch (err) { return JSON.stringify({ error: err.message }); }
    },

    async get_kol_tweets({ username, max_results = 5 } = {}) {
      if (!username) return JSON.stringify({ error: 'username required' });
      try {
        const data = await _twitterPost('/twitter_user_tweets', {
          username, maxResults: Math.min(max_results, 10),
        });
        if (data.error) return JSON.stringify(data);
        const tweets = (data.data || []).slice(0, 10).map(t => ({
          text: (t.text || '').slice(0, 200),
          likes: t.favoriteCount || 0,
          retweets: t.retweetCount || 0,
          replies: t.replyCount || 0,
          date: t.createdAt || '',
        }));
        return JSON.stringify({ username, count: tweets.length, tweets });
      } catch (err) { return JSON.stringify({ error: err.message }); }
    },

    async get_fear_greed() {
      try {
        const fg = intelStream?.getFearGreed?.();
        if (fg?.value != null) return JSON.stringify(fg);
        // Fallback: fetch directly
        const res = await fetch('https://cryptocurrency.cv/api/market/fear-greed', { signal: AbortSignal.timeout(10000) });
        if (!res.ok) return JSON.stringify({ error: 'fear-greed API unavailable' });
        const data = await res.json();
        return JSON.stringify({
          value: data.current?.value ?? data.fgi?.value ?? null,
          label: data.current?.valueClassification ?? data.fgi?.classification ?? null,
        });
      } catch (err) { return JSON.stringify({ error: err.message }); }
    },

    async get_intel_feed({ limit = 15 } = {}) {
      try {
        const items = intelStream?.getRecentIntel?.(limit) || [];
        if (items.length === 0) return JSON.stringify({ count: 0, note: 'No recent intel (TG channels quiet or pollers warming up)' });
        return JSON.stringify({
          count: items.length,
          items: items.map(i => ({
            title: (i.title || '').slice(0, 150),
            score: i.score,
            signal: i.signal,
            source: i.source,
          })),
        });
      } catch (err) { return JSON.stringify({ error: err.message }); }
    },
    // --- K-line Monitor executors ---
    kline_subscribe: async ({ pair }) => {
      if (!pair) return JSON.stringify({ error: 'pair required (e.g. JOE-USDT)' });
      const result = klineMonitor?.subscribe?.(pair);
      return JSON.stringify(result || { error: 'kline monitor not available' });
    },
    kline_unsubscribe: async ({ pair }) => {
      if (!pair) return JSON.stringify({ error: 'pair required' });
      const result = klineMonitor?.unsubscribe?.(pair);
      return JSON.stringify(result || { error: 'kline monitor not available' });
    },
    kline_status: async () => {
      const status = klineMonitor?.getStatus?.() || [];
      return JSON.stringify({ monitored_pairs: status.length, pairs: status });
    },
    kline_indicators: async ({ pair, timeframe }) => {
      if (!pair) return JSON.stringify({ error: 'pair required (e.g. BTC-USDT)' });
      const ind = klineMonitor?.getIndicators?.(pair, timeframe || '5m');
      if (!ind) return JSON.stringify({ error: `No data for ${pair} ${timeframe || '5m'} — not subscribed or not enough candles yet` });
      return JSON.stringify(ind);
    },
  };

  return { TOOL_DEFS, EXECUTORS };
}
