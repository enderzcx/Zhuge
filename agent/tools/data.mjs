/**
 * Data tools — market data queries via TG agent.
 *   crucix_data, fetch_news, market_scan, price, agent_decisions,
 *   explore_codebase, query_metrics, read_logs, status_report
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

export function createDataTools({ dataSources, priceStream, db, scanner, pushEngine, compound, readLogs }) {
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

    async tg_urgent() {
      try {
        const crucix = await fetchCrucix();
        const urgent = crucix?.tg?.urgent || [];
        if (urgent.length === 0) return '当前无紧急快讯';
        return urgent.slice(0, 10).map(u =>
          `[${u.channel || '?'}] ${(u.text || '').slice(0, 200)}`
        ).join('\n\n');
      } catch (err) {
        return `{ "error": "${err.message}" }`;
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
        return `{ "error": "${err.message}" }`;
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
        return `{ "error": "${err.message}" }`;
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
        return `{ "error": "${err.message}" }`;
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

        // 1. Project info
        try {
          const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
          parts.push(`项目: ${pkg.name} v${pkg.version}\n依赖: ${Object.keys(pkg.dependencies || {}).join(', ')}`);
        } catch {}

        // 2. File tree with line counts
        const modules = [];
        function scanDir(dir, prefix = '') {
          try {
            for (const f of readdirSync(dir)) {
              if (f.startsWith('.') || f === 'node_modules' || f === 'data') continue;
              const full = join(dir, f);
              const stat = statSync(full);
              if (stat.isDirectory()) scanDir(full, prefix + f + '/');
              else if (f.endsWith('.mjs') || f.endsWith('.md')) {
                const lines = readFileSync(full, 'utf-8').split('\n').length;
                modules.push({ path: prefix + f, lines });
              }
            }
          } catch {}
        }
        scanDir(root);
        const tree = modules.sort((a, b) => b.lines - a.lines).map(m => `  ${m.path} (${m.lines}行)`).join('\n');
        parts.push(`文件 (${modules.length}个, ${modules.reduce((s, m) => s + m.lines, 0)}行):\n${tree}`);

        // 3. Sub-agents — read first comment block from each
        const agentDir = join(root, 'agents');
        const agentFiles = readdirSync(agentDir).filter(f => f.endsWith('.mjs'));
        const agentDescs = agentFiles.map(f => {
          const content = readFileSync(join(agentDir, f), 'utf-8');
          const comment = content.match(/\/\*\*?\s*\n?\s*\*?\s*(.+?)[\n*]/)?.[1]?.trim() || f;
          return `  ${f}: ${comment}`;
        });
        parts.push(`子 Agent (${agentFiles.length}个):\n${agentDescs.join('\n')}`);

        // 4. Automation schedule
        parts.push(`自动化:\n  pipeline: 每30分钟 (analyst→risk→trade→strategist)\n  scanner: 每30分钟 (momentum 发现+研究+交易)\n  pending_review: 每5分钟 (订单同步)\n  dashboard: positions每5min, observe每2h, chart每6h\n  health: 每60秒采集 (heap/rss/cpu/event_loop)\n  compound: 每10笔交易关闭后自动复盘`);

        // 5. PM2 processes
        try {
          const { execSync } = await import('child_process');
          const pm2 = execSync('pm2 jlist', { encoding: 'utf-8', timeout: 5000 });
          const procs = JSON.parse(pm2).map(p => `  ${p.name}: ${p.pm2_env.status} | mem:${Math.round(p.monit.memory / 1024 / 1024)}MB | uptime:${Math.round((Date.now() - p.pm2_env.pm_uptime) / 3600000)}h`);
          parts.push(`PM2 进程:\n${procs.join('\n')}`);
        } catch {}

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
  };

  return { TOOL_DEFS, EXECUTORS };
}
