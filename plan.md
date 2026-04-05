# Data Center V2 — Agent Harness + Dashboard + Observability

> Owner: 0xEnder | Created: 2026-04-04
> Architecture: Harness Engineering (prompts as control plane, fail-closed defaults, latch stability)

---

## Vision

将数据中心 VPS 从"一堆独立服务"升级为**统一的 AI Native 数据中心**：
- TG 智能体：IM 式自然语言控制整个 VPS
- 智能推送：AI 分析后决策推送，带完整上下文 + 原始 URL
- 可观测性：自建轻量 metrics/logger，不依赖外部栈
- Dashboard：Next.js 轻量看板，实时持仓/决策/指标
- 一级市场：Base V3 新池检测 + Token 安全扫描（Phase 5）

---

## Architecture

```
tradeagent/
├── agent/                    ← 数据中心智能体 Harness (~3300 lines, 24 files)
│   ├── loop.mjs              ← Agent Loop (async generator)           ~250
│   ├── llm.mjs               ← LLM 调用封装 (流式 + fallback)        ~150
│   ├── history.mjs           ← 对话历史 + 3层压缩                    ~150
│   ├── model-select.mjs      ← 模型选择策略 + latch                  ~80
│   ├── tools/
│   │   ├── registry.mjs      ← 工具 schema + 注册 + defaults         ~100
│   │   ├── executor.mjs      ← 执行引擎 + 并发控制                   ~150
│   │   ├── system.mjs        ← exec_shell / read_file / write_file   ~200
│   │   ├── data.mjs          ← crucix_data / fetch_news / market     ~200
│   │   ├── trade.mjs         ← positions / balance / open / close    ~200
│   │   └── memory.mjs        ← save_memory / read_memory             ~100
│   ├── telegram/
│   │   ├── bot.mjs           ← TG polling + message routing          ~200
│   │   ├── stream.mjs        ← 流式 editMessage (500ms interval)     ~100
│   │   └── confirm.mjs       ← 危险操作 inline keyboard 确认         ~80
│   ├── push/
│   │   ├── engine.mjs        ← AI 推送决策 + 格式化 + URL            ~150
│   │   └── log.mjs           ← push_log 完整上下文存储               ~80
│   ├── observe/
│   │   ├── metrics.mjs       ← SQLite 时序 metrics 表                ~150
│   │   ├── logger.mjs        ← 结构化 JSON lines 日志 (7d rolling)   ~100
│   │   └── health.mjs        ← 服务健康检查 + 系统资源               ~80
│   ├── prompts/
│   │   ├── base.md           ← 角色 + 行为准则 (static, cacheable)
│   │   ├── tools.md          ← 工具描述 + 使用规则
│   │   ├── safety.md         ← 危险操作规则 + 确认条件
│   │   └── loader.mjs        ← 动态拼装 system prompt                ~100
│   ├── cognition/                ← AI Native 知识复利系统 (独有)
│   │   ├── provenance.mjs        ← 决策全量存储 (开仓快照+关闭回填)    ~150
│   │   └── compound.mjs          ← LLM 自主复盘 (自己发现pattern写规则) ~150
│   └── memory/
│       ├── MEMORY.md              ← 记忆索引
│       ├── context.md             ← 当前状态
│       ├── trading_lessons.md     ← 交易教训 (reviewer 写入)
│       ├── owner_directives.md    ← 老板指令 (用户策略约束)
│       ├── market_context.md      ← 市场判断 (分析后更新)
│       └── push_log.md            ← 最近推送 (完整分析链路)
│
├── dashboard/                 ← Next.js 轻量看板 (~800 lines)
│   ├── app/
│   │   ├── page.tsx           ← 主看板: 持仓 + PnL + agent 状态
│   │   ├── trades/page.tsx    ← 交易历史 + PnL 曲线
│   │   ├── decisions/page.tsx ← 决策时间线 (analyst→risk→结果)
│   │   ├── observe/page.tsx   ← 指标图表 + 日志流
│   │   ├── pushes/page.tsx    ← 推送历史 (带新闻 URL)
│   │   └── api/
│   │       ├── live/route.ts  ← SSE 实时推送
│   │       └── metrics/route.ts
│   └── components/
│       ├── PnlChart.tsx       ← PnL 曲线 (recharts/uplot)
│       ├── DecisionTimeline.tsx
│       ├── LiveLog.tsx
│       └── StatusCard.tsx
│
├── pipeline.mjs               ← 现有交易管线 (改动: 接入 observe + push)
├── agents/                    ← 现有 AI agents (不动)
├── bitget/                    ← 现有交易引擎 (不动)
├── market/                    ← 现有市场扫描 (不动)
├── integrations/              ← 现有数据源 (改动: news 保留 URL)
└── stockpulse/                ← 废弃，功能合并到 agent/telegram + agent/push
```

---

## Harness Engineering Principles

### 1. Prompts as Control Plane
- Agent 行为通过 md 文件的 system prompt 控制，不硬编码 if/else
- 静态部分 (base.md, tools.md, safety.md) 可缓存
- 动态部分 (state/memory/market) 每轮对话注入

### 2. Fail Closed, Explicitly Open
- 所有工具默认 `requiresConfirmation: true`
- 只有明确标记安全的工具 (positions, balance, price) 跳过确认
- exec_shell 永远需要确认，除非命令匹配安全白名单 (ls, cat, df, ps)

### 3. Latch for Stability
- 模型选择: 一轮对话内锁定，不每 turn 重选
- 推送去重: 已推送新闻 SHA256 存入 Set，不重复推
- 错误恢复: LLM 连续失败 3 次 → 降级 mini，不反复重试 5.4

### 4. Observe Before Fixing
- metrics 采集在 agent loop 每阶段
- 结构化日志替代 console.log
- Dashboard 只读 metrics，不修改业务逻辑

### 5. 300 Lines/File Ceiling
- 最大单文件 250 行，超出必须拆分
- 每个文件单一职责

### 6. AI Native Self-Improvement (独有设计)
- Agent 从自己的交易经验中自主发展"盘感"，不是人写规则
- 人只做两件事: 存好数据 (provenance) + 让 LLM 自己复盘 (compound)
- 不预设 pattern 维度，LLM 自己发现什么维度重要

---

## Compound Knowledge System (知识复利)

> 灵感: Compound Engineering — 每次工作的产出不只是代码，还有知识。
> 我们的版本: 每笔交易的产出不只是 PnL，还有 LLM 自主发现的认知。
>
> 关键区别: CE 是文档级复利 (markdown)，我们是 LLM 自主复盘式复利。
> CE 人工触发 /ce:compound，我们自动触发 (每 N 笔交易)。

### 角色定义

- **Agent = 操盘手**：自主执行分析、开平仓、风控、自我复盘
- **用户 = 基金经理/老板**：设定策略约束、监督、偶尔干预
- 知识的发现者是 LLM 自己，不是人类工程师

### 为什么这样设计 (数据驱动的决策)

2026-04-05 对实际交易数据的分析发现：
- 17 笔真实交易，全部来自 momentum researcher，不是 analyst
- analyst 做了 312 次分析，0 次 strong_buy，从不触发交易
- signal_snapshot 全是空的 — agent 对自己的决策上下文完全失忆
- 样本太小，无法用 SQL 做有统计意义的 pattern 检测

结论：不预设 pattern 维度 (时间/funding/regime)，先存好数据，让 LLM 自己发现 pattern。

### Module 1: provenance.mjs — 决策全量存储 (纯工程，无 AI)

交易时把所有上下文存下来。这是基础设施，没有这个什么都做不了。

```sql
CREATE TABLE IF NOT EXISTS decision_provenance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id TEXT NOT NULL,
  trace_id TEXT,

  -- 开仓时存 (完整快照)
  symbol TEXT,
  side TEXT,
  leverage INTEGER,
  entry_price REAL,
  momentum_score INTEGER,          -- researcher 评分
  funding_rate REAL,
  volume_24h REAL,
  volume_ratio REAL,               -- 当前小时量 / 6h均量
  price_action_json TEXT,          -- K线结构 { higher_highs, trend, max_candle_pct }
  hour_utc INTEGER,
  researcher_reasoning TEXT,       -- 完整开仓理由
  risk_verdict TEXT,               -- PASS/VETO + reason
  active_rules_json TEXT,          -- 开仓时生效的 compound rules

  -- 关闭时回填
  exit_price REAL,
  pnl REAL,
  pnl_pct REAL,
  hold_duration_min INTEGER,
  max_drawdown_pct REAL,

  created_at TEXT DEFAULT (datetime('now')),
  closed_at TEXT
);
```

**关键: 字段来自实际数据，不是凭空设计。** momentum_score, funding_rate, volume_ratio,
hour_utc — 这些都是 researcher reasoning 里反复出现的决策因子。

### Module 2: compound.mjs — LLM 自主复盘 (纯 AI，无人写规则)

每 N 笔交易后（或每天），LLM 读取所有带 provenance 的交易，自己发现 pattern，自己写规则。

**触发时机:**
```
每 10 笔交易关闭 → 触发 compound
或每天 end-of-day → 触发 compound (如果有新关闭的交易)
```

**Compound LLM Prompt:**
```
你是一个交易复盘专家。以下是你最近 N 笔交易的完整数据:

[每笔交易的 provenance 数据: symbol, side, momentum_score, funding_rate,
 volume_ratio, hour_utc, reasoning, pnl_pct, hold_duration, ...]

请分析:
1. 你发现了什么 pattern? (赢的交易有什么共同点? 亏的呢?)
2. 有没有你应该避免的条件组合?
3. 有没有你表现特别好的条件?
4. 之前的规则 (如果有) 是否需要更新或废弃?

输出 JSON 数组, 每条规则:
{
  "rule_id": "unique_id",
  "description": "人类可读的规则描述",
  "action": "avoid | prefer | adjust_size | adjust_sl",
  "evidence": "哪些交易支撑这条规则 (trade_ids)",
  "trade_count": 5,
  "confidence": 0.7,
  "status": "active | superseded"
}
```

**输出存入 compound_rules 表:**
```sql
CREATE TABLE IF NOT EXISTS compound_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT UNIQUE,
  description TEXT NOT NULL,       -- LLM 写的规则描述
  action TEXT,                     -- avoid | prefer | adjust_size
  evidence_trade_ids TEXT,         -- 支撑这条规则的交易 IDs
  trade_count INTEGER,             -- 基于多少笔交易
  confidence REAL DEFAULT 0,       -- LLM 自评的置信度
  status TEXT DEFAULT 'active',    -- active | superseded | deprecated
  source_compound_id INTEGER,      -- 哪次 compound 产出的
  discovered_at TEXT DEFAULT (datetime('now')),
  superseded_at TEXT,
  superseded_by TEXT               -- 被哪条新规则替代
);

CREATE TABLE IF NOT EXISTS compound_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trades_reviewed INTEGER,
  rules_generated INTEGER,
  rules_updated INTEGER,
  rules_deprecated INTEGER,
  llm_reasoning TEXT,              -- LLM 完整复盘输出 (审计用)
  run_at TEXT DEFAULT (datetime('now'))
);
```

**规则注入 system prompt:**
```
## 你的交易认知 (由 AI 自主复盘产出, 非人工编写)
⚠ 避免: momentum_score < 64 的交易历史胜率仅 30% (基于 6 笔)
⚠ 避免: volume_ratio < 1.0 时开仓, 4 笔全亏
✓ 偏好: funding_rate 为负时做多, 胜率 71% (基于 7 笔)
📝 观察: UTC 18:00-21:00 时段表现最好 (样本少, 待验证)
```

**生命周期 (LLM 自己管理):**
```
compound run #1 (10笔数据) → 发现 3 条初步规则 (confidence 低)
compound run #2 (20笔数据) → 验证 2 条, 废弃 1 条, 新发现 1 条
compound run #3 (30笔数据) → 规则合并, confidence 提升
...
LLM 每次复盘时看到之前的规则, 自己决定: 保留 / 更新 / 废弃
```

**与 CE 的对比:**
```
CE:  人工判断是否值得 compound → 人工跑 /ce:compound → 存 markdown → agent 搜文档
我们: 自动触发 → LLM 自主复盘 → 存结构化规则 → 直接注入 prompt (无需再理解)
```

### 回溯查询 (TG 对话)

```
用户: "上笔为什么亏了"
Agent 查 decision_provenance:
  RLSUSDT buy 10x | score:70 funding:+0.005% vol_ratio:2.14x
  开仓理由: 大阳线+51%, 量能放大, 趋势上行
  结果: pnl -16.4%, 持仓 60min

  compound 规则匹配:
  → ⚠ "volume_ratio > 2x 但 score < 65 的交易历史胜率低"
  → 这笔 score=70 但实际是 researcher 给的高分, 价格已经涨完了

  建议: 下次大阳线后追涨要更谨慎, 已记录待下次 compound 更新
```

---

### Owner Directives (老板指令系统)

用户不是交易员，是监督者。用户的输入变成长期策略约束：

```
# owner_directives.md (agent 严格遵守)

## 硬约束 (永不违反)
- 杠杆不超过 10x [来源: 用户 2026-03-15]
- 不做山寨币 top50 以外的币种 [来源: 用户 2026-04-01]
- 单笔最大亏损不超过总余额 3% [来源: 用户 2026-03-20]

## 软约束 (可被 agent 建议修改)
- 每天最多开 3 笔新仓 [来源: 用户 2026-04-02]
- 优先做空而不是做多 [来源: 用户 2026-04-05, 可能过时]

## 策略方向
- 当前偏好: 保守, 等待明确信号
- 关注: BTC ETH SOL
```

**与 compound rules 的交互：** 如果 LLM compound 发现某个 owner directive 导致错过好机会，agent 会在推送中建议修改，但不会自动违反。Owner directives 永远优先于 compound rules。

---

## Agent Loop Design

```
用户 TG 消息
    ↓
bot.mjs: 收消息 → 加载对话历史
    ↓
loader.mjs: 拼装 system prompt
  = base.md + tools.md + safety.md
  + [动态] 当前持仓/余额
  + [动态] memory/context.md
  + [动态] memory/push_log.md (最近5条)
    ↓
loop.mjs: async generator agent loop
  ┌─────────────────────────────┐
  │ while (true):               │
  │   1. llm.mjs: 流式调 LLM   │
  │   2. 提取 tool_use blocks   │
  │   3. if 无 tool_use → break │
  │   4. executor.mjs: 执行     │
  │      - 安全工具: 并行       │
  │      - 危险工具: confirm → 串行 │
  │   5. 结果 → history         │
  │   6. continue               │
  └─────────────────────────────┘
    ↓
stream.mjs: 流式 editMessage 到 TG (500ms)
    ↓
observe: 记录 metrics (latency, tokens, tool_calls)
```

### Context Management (3 层)

```
Layer 1: Tool Result Budgeting
  → 单个工具输出 > 2000 chars 自动截断 + 摘要

Layer 2: Sliding Window
  → 保留最近 20 轮对话

Layer 3: Auto-Summarize
  → 超 20 轮时，LLM 把前 15 轮压缩成一段摘要
  → 摘要 + 最近 5 轮 = 新 history
```

### Model Selection Strategy

```
gpt-5.4-mini (default):
  - 简单查询: 持仓、余额、价格
  - 单工具调用
  - 快捷命令

gpt-5.4 (升级条件):
  - 用户消息包含分析/推理类关键词
  - tool calls > 3 个
  - 对话 > 5 轮
  - 用户明确要求深度分析

Latch: 一轮对话选定后不切换
```

---

## Tool System

### Schema Format

```js
{
  name: 'exec_shell',
  description: '在 VPS 上执行 bash 命令',
  inputSchema: { cmd: { type: 'string', description: '要执行的命令' } },
  requiresConfirmation: true,
  isDestructive: true,
  safePatterns: [/^(ls|cat|head|tail|df|free|ps|pm2 list|git log|git status)/],
  maxExecutionTime: 30000,
  maxResultChars: 2000,
}
```

### Tool Inventory (15 tools)

**System (VPS 控制):**
- [ ] `exec_shell` — bash 命令 (危险操作确认, 安全命令白名单跳过)
- [ ] `read_file` — 读文件 (确认)
- [ ] `write_file` — 写文件 (确认)
- [ ] `pm2_action` — restart/stop/logs (确认 stop, logs 免确认)
- [ ] `system_status` — CPU/内存/磁盘/进程 (免确认)

**Data (数据查询):**
- [ ] `crucix_data` — 查 Crucix 任意 key (免确认)
- [ ] `fetch_news` — AI 评分新闻 + 原始 URL (免确认)
- [ ] `market_scan` — Bitget 540+ futures 快照 (免确认)
- [ ] `price` — 实时价格 via OKX WS (免确认)
- [ ] `agent_decisions` — 最近 N 条 AI 决策 (免确认)

**Trade (交易操作):**
- [ ] `positions` — 当前持仓 + 未实现 PnL (免确认)
- [ ] `balance` — 余额 + 保证金 (免确认)
- [ ] `open_trade` — 开仓 (确认: 显示 symbol/side/size/leverage)
- [ ] `close_trade` — 平仓 (确认: 显示当前 PnL)
- [ ] `pause_trading` / `resume_trading` — 暂停/恢复 (确认)

**Memory:**
- [ ] `save_memory` — 写入 md 记忆文件 (免确认)
- [ ] `read_memory` — 读取 md 记忆文件 (免确认)

---

## Push System

### 推送级别

| Level | Trigger | Example |
|-------|---------|---------|
| FLASH | VIX > 25, BTC -5%+, 地缘冲突升级, 美联储紧急操作 | "VIX 飙至 28，美伊冲突升级" |
| TRADE | 开仓/平仓/止损触发 | "LONG PUFFER 10x @ $0.0266" |
| ERROR | Agent 挂了, API 连续失败 3+ 次 | "Bitget API timeout 5次" |
| PATROL | 3h 汇总 (现有) | 巡逻报告 |

### 推送数据结构

```js
{
  id: 'push_20260404_093015',
  level: 'FLASH',
  text: '美联储官员暗示6月加息，美元指数升至104.8',
  url: 'https://coindesk.com/...',           // 原始新闻 URL
  analysis: { ... },                          // analyst 完整 JSON
  raw_news: [{ title, url, score, signal }],  // 原始新闻数据
  reasoning: '...',                           // AI 推送理由
  trace_id: 'analysis_crypto_1712...',        // 关联分析 trace
  pushed_at: '2026-04-04T09:30:15Z',
}
```

---

## Observability

### Metrics Table (SQLite)

```sql
CREATE TABLE metrics (
  ts INTEGER NOT NULL,
  name TEXT NOT NULL,
  value REAL NOT NULL,
  tags TEXT DEFAULT '{}'
);
CREATE INDEX idx_metrics ON metrics(name, ts);
```

### 采集点

| Metric | When | Tags |
|--------|------|------|
| `llm_latency_ms` | 每次 LLM 调用 | {agent, model} |
| `llm_tokens_in` | 每次 LLM 调用 | {agent, model} |
| `llm_tokens_out` | 每次 LLM 调用 | {agent, model} |
| `tool_latency_ms` | 每次工具执行 | {tool, success} |
| `trade_pnl` | 每笔交易关闭 | {symbol, side} |
| `api_latency_ms` | 外部 API 调用 | {service: bitget/crucix/opennews} |
| `error_count` | 每次错误 | {module, type} |
| `system_heap_mb` | 每分钟 | {} |
| `system_rss_mb` | 每分钟 | {} |
| `push_sent` | 每次推送 | {level} |
| `tg_msg_received` | 每条 TG 消息 | {} |
| `tg_reply_latency_ms` | 每次回复 | {model} |

### Structured Logger

```js
// 替代所有 console.log
log.info('trade_opened', { symbol: 'ETHUSDT', side: 'long', size: 0.05 });
log.error('bitget_timeout', { endpoint: '/api/v2/mix/...', attempt: 3 });
```

输出: JSON lines → `data/logs/YYYY-MM-DD.jsonl`，7 天自动清理。

---

## Dashboard (Next.js)

### Pages

| Route | Content | Data Source | Refresh |
|-------|---------|-------------|---------|
| `/` | 持仓 + PnL + Agent 状态 + 余额 | TradeAgent :3200 API | 30s polling |
| `/trades` | 交易历史表 + PnL 曲线 | SQLite trades 表 | 60s |
| `/decisions` | 决策时间线 (analyst→risk→结果) | SQLite decisions 表 | SSE |
| `/observe` | 指标图表 + 日志流 + 系统资源 | SQLite metrics + log files | SSE |
| `/pushes` | 推送历史 (带新闻 URL + AI 分析) | SQLite push_history | 60s |

### Tech
- Next.js App Router + Server Components
- recharts 或 uplot (图表)
- SSE for real-time events
- Tailwind CSS
- 独立 pm2 进程, port 3000

---

## Existing Code Changes

### integrations/data-sources.mjs
- [x] `fetchNews()`: 保留 `url` 字段 in returned objects
- [x] `persistNews()`: 存 url 到 DB

### pipeline.mjs
- [x] 接入 observe/logger (替代 console.log)
- [x] 接入 observe/metrics (agent 调用计时)
- [ ] 接入 push/engine (分析后推送决策) — Phase 3
- [ ] 推送时带完整 analysis + news URLs — Phase 3

### db.mjs
- [x] 新增 `metrics` 表 (在 metrics.mjs 中自建)
- [x] 新增 `push_history` 表
- [ ] 新增 `decision_provenance` 表 — Phase 2e
- [ ] 新增 `compound_rules` / `compound_runs` 表 — Phase 2e

### stockpulse/
- [ ] 废弃，TG bot 功能迁移到 agent/telegram/
- [ ] StockPulse 命令 (/watch /brief /detail) 作为 agent tools 保留

---

## Phases

### Phase 1: Foundation — 可观测性 + 数据修复
- [x] observe/metrics.mjs — SQLite metrics 表 + 采集函数
- [x] observe/logger.mjs — 结构化日志
- [x] observe/health.mjs — 系统资源采集
- [x] pipeline.mjs 接入 logger + metrics
- [x] data-sources.mjs 保留 news URL
- [x] db.mjs 新增 metrics / push_history 表
- [ ] 部署验证: `deploy.sh`, 确认 metrics 写入正常

### Phase 2: TG Agent — 核心智能体 + Compound Knowledge

**2a: Agent Core (基础框架)**
- [ ] agent/llm.mjs — LLM 调用封装 (流式 + fallback)
- [ ] agent/loop.mjs — async generator agent loop
- [ ] agent/history.mjs — 对话历史 + 3层压缩
- [ ] agent/model-select.mjs — 模型选择 + latch

**2b: Tool System (工具系统)**
- [ ] agent/tools/registry.mjs — 工具注册 + schema + defaults
- [ ] agent/tools/executor.mjs — 执行引擎 + 确认机制
- [ ] agent/tools/system.mjs — VPS 控制工具
- [ ] agent/tools/data.mjs — 数据查询工具
- [ ] agent/tools/trade.mjs — 交易操作工具
- [ ] agent/tools/memory.mjs — 记忆读写

**2c: Telegram Interface (TG 接入)**
- [ ] agent/telegram/bot.mjs — TG polling + routing
- [ ] agent/telegram/stream.mjs — 流式 editMessage
- [ ] agent/telegram/confirm.mjs — 危险操作 inline keyboard 确认

**2d: Prompts & Memory (提示词 + 记忆)**
- [ ] agent/prompts/base.md — 角色: 自主操盘手, 用户是老板/监督者
- [ ] agent/prompts/tools.md — 工具描述 + 使用规则
- [ ] agent/prompts/safety.md — 危险操作规则 + 确认条件
- [ ] agent/prompts/loader.mjs — 动态拼装 (static + compound_rules + directives)
- [ ] agent/memory/ — context.md + owner_directives.md + push_log.md

**2e: Compound Knowledge — AI Native 知识复利系统 (独有)**
- [ ] db.mjs 新增 decision_provenance / compound_rules / compound_runs 表
- [ ] agent/cognition/provenance.mjs — 决策全量存储 (纯工程)
  - 开仓时: 存 momentum_score, funding_rate, volume_ratio, hour_utc, reasoning 等完整快照
  - 关闭时: 回填 pnl, pnl_pct, hold_duration, max_drawdown
  - 字段来自实际交易数据分析，不是凭空设计
- [ ] agent/cognition/compound.mjs — LLM 自主复盘 (纯 AI)
  - 触发: 每 10 笔交易关闭，或每天 end-of-day
  - LLM 读取所有带 provenance 的交易，自己发现 pattern，自己写规则
  - 规则存入 compound_rules 表，下次交易前注入 system prompt
  - LLM 每次复盘时看到之前的规则，自己决定: 保留 / 更新 / 废弃
- [ ] momentum researcher prompt 改造
  - 开仓时必须存完整 snapshot 到 provenance (当前 signal_snapshot 是空的)
  - 强制输出 anti_thesis + kill_condition (零额外 LLM call，改 prompt 即可)
- [ ] provenance 闭环: 交易关闭 → 回填结果 → 累积到下一次 compound 的输入

**2f: 验收**
- [ ] TG 发 "我的仓位" → 返回持仓
- [ ] TG 发 "df -h" → 确认后执行
- [ ] TG 发 "杠杆不要超过5x" → 写入 owner_directives.md
- [ ] decision_provenance 有完整开仓快照 (不再是空的 signal_snapshot)
- [ ] 手动触发一次 compound → compound_rules 表有 LLM 自主发现的规则
- [ ] "上笔为什么亏了" → provenance 回溯完整决策链

### Phase 3: Smart Push — 智能推送引擎
- [ ] agent/push/engine.mjs — AI 推送决策
- [ ] agent/push/log.mjs — push_log 上下文存储
- [ ] pipeline.mjs 接入 push engine
- [ ] 推送带原始 URL + 完整分析链路
- [ ] TG 追问带上下文
- [ ] 部署验证: 等待下一轮 FLASH 级新闻，确认推送 + 追问

### Phase 4: Dashboard — Web 看板
- [ ] dashboard/ Next.js 项目初始化
- [ ] TradeAgent API 扩展 (metrics/decisions/pushes 接口)
- [ ] 主看板: 持仓 + PnL + 状态
- [ ] 交易历史 + PnL 曲线
- [ ] 决策时间线
- [ ] 可观测性图表 + 日志流
- [ ] 推送历史
- [ ] ecosystem.config.cjs 加 dashboard 进程
- [ ] 部署验证: 浏览器访问看板，数据实时更新

### Phase 5: Primary Market — 一级市场 (后续)
- [ ] Base V3 Factory PoolCreated 事件监听
- [ ] Token 安全扫描 (honeypot detection)
- [ ] Uniswap V3 swap 执行
- [ ] SessionManagerV2 白名单 V3 Router
- [ ] 整合到 pipeline + TG 推送

---

## Resource Budget

| Component | Memory | Disk |
|-----------|--------|------|
| TradeAgent (现有) | 122MB | 211MB |
| Agent Harness (新增) | +20-30MB | +5MB (memory md files) |
| Cognition/Compound (新增) | +5MB | +5MB/month (provenance + compound_rules) |
| Observe (新增) | +5MB | +50MB/week (logs + metrics) |
| Dashboard (新增) | +60-80MB | +50MB (node_modules) |
| **Total** | ~260MB | ~330MB |
| **VPS Available** | 2300MB | 38GB |
| **Utilization** | 11% | <1% |

---

## Verification Criteria

每个 Phase 完成时的验收：

**Phase 1:** `SELECT COUNT(*) FROM metrics` 有数据; logs/ 有 JSON lines 文件; news 有 URL
**Phase 2:** TG 发 "我的仓位" → 返回持仓; "df -h" → 确认后执行; "杠杆不超过5x" → 写入 owner_directives; decision_provenance 有完整开仓快照 (不再是空的); 手动跑一次 compound → compound_rules 有 LLM 自主发现的规则; "上笔为什么亏了" → provenance 回溯完整决策链
**Phase 3:** FLASH 新闻自动推送到 TG 带 URL; 回复 "详细说说" → 带上下文回答
**Phase 4:** 浏览器看到实时 PnL 曲线 + 决策时间线 + 指标图表
**Phase 5:** 检测到 Base 新池 → TG 推送 → 可以下令买入
