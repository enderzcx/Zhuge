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
│   └── memory/
│       ├── MEMORY.md          ← 记忆索引
│       ├── context.md         ← 当前状态
│       ├── trading_lessons.md ← 交易教训 (reviewer 写入)
│       ├── user_preferences.md← 用户偏好 (对话学习)
│       ├── market_context.md  ← 市场判断 (分析后更新)
│       └── push_log.md        ← 最近推送 (完整分析链路)
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
- [ ] `fetchNews()`: 保留 `url` 字段 in returned objects
- [ ] `persistNews()`: 存 url 到 DB

### pipeline.mjs
- [ ] 接入 observe/logger (替代 console.log)
- [ ] 接入 observe/metrics (agent 调用计时)
- [ ] 接入 push/engine (分析后推送决策)
- [ ] 推送时带完整 analysis + news URLs

### db.mjs
- [ ] 新增 `metrics` 表
- [ ] 新增 `push_history` 表
- [ ] `news` 表加 `url` 字段

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

### Phase 2: TG Agent — 核心智能体
- [ ] agent/loop.mjs — async generator agent loop
- [ ] agent/llm.mjs — LLM 调用封装 (流式)
- [ ] agent/history.mjs — 对话历史 + 3层压缩
- [ ] agent/model-select.mjs — 模型选择 + latch
- [ ] agent/tools/registry.mjs — 工具注册 + schema + defaults
- [ ] agent/tools/executor.mjs — 执行引擎
- [ ] agent/tools/system.mjs — VPS 控制工具
- [ ] agent/tools/data.mjs — 数据查询工具
- [ ] agent/tools/trade.mjs — 交易操作工具
- [ ] agent/tools/memory.mjs — 记忆读写
- [ ] agent/prompts/ — base.md + tools.md + safety.md + loader.mjs
- [ ] agent/memory/ — MEMORY.md + context.md + ...
- [ ] agent/telegram/bot.mjs — TG polling + routing
- [ ] agent/telegram/stream.mjs — 流式 editMessage
- [ ] agent/telegram/confirm.mjs — 危险操作确认
- [ ] 部署验证: TG 发消息，能查持仓、跑命令、记住偏好

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
| Observe (新增) | +5MB | +50MB/week (logs + metrics) |
| Dashboard (新增) | +60-80MB | +50MB (node_modules) |
| **Total** | ~250MB | ~320MB |
| **VPS Available** | 2300MB | 38GB |
| **Utilization** | 11% | <1% |

---

## Verification Criteria

每个 Phase 完成时的验收：

**Phase 1:** `SELECT COUNT(*) FROM metrics` 有数据; logs/ 有 JSON lines 文件; news 有 URL
**Phase 2:** TG 发 "我的仓位" → 返回持仓; "df -h" → 确认后执行; "记住我喜欢保守策略" → 写入 memory
**Phase 3:** FLASH 新闻自动推送到 TG 带 URL; 回复 "详细说说" → 带上下文回答
**Phase 4:** 浏览器看到实时 PnL 曲线 + 决策时间线 + 指标图表
**Phase 5:** 检测到 Base 新池 → TG 推送 → 可以下令买入
