# 诸葛架构重构计划

更新时间: 2026-04-09
状态: codex-reviewed, approved
依据: Anthropic Claude Managed Agents 工程实践 + AlexZ Agent OS 分析

## 背景

对照 Anthropic 的 Agent OS 三层抽象（Session / Harness / Sandbox），诸葛存在以下结构性问题：

1. Session = Context Window（crash 不可恢复，1h TTL 后全丢）
2. Harness 有状态且 hardcoded（pipeline.mjs 串行调用，cache 在内存）
3. Sandbox 无隔离（65 个 tool 同进程，exec_shell 可读 .env）
4. "多 Agent" 实为串行 LLM 调用，无真正协作
5. K 线信号检测是硬编码规则，不是 AI 判断

核心原则（来自 AlexZ）：
> Agent 框架最忌讳的是把"暂时性的模型缺陷"上升为"永久性的系统结构"

## P0: 安全修复（立即）

### exec_shell 加固

问题：`cat .env` 匹配 safe pattern（`/^cat/`），LLM 可被 prompt injection 读取 API key。

修复：
- 从 SAFE_COMMANDS 中移除 `cat`（或加路径黑名单：.env, secret, key, token, pass, credentials）
- 考虑从 TG agent 的 tool set 中完全移除 exec_shell（system_status 已覆盖基本需求）

## Phase 1: 生产可靠性（本周）

### 1.1 Event Log

目标：pipeline 每个决策点写 event，crash 后可恢复。

实现：
- 扩展现有 `agent_messages` 表，或新建 `pipeline_events` 表
- 字段：event_id, event_type, timestamp, actor, payload_json, trace_id, cycle_id
- 埋点位置：signal_detected, analyst_started, analyst_result, risk_verdict, strategy_triggered, trade_executed, cycle_complete
- Crash recovery：启动时读最后一个未完成 cycle，跳过（市场数据已过时，replay 无意义）
- 不是 checkpoint+resume，而是 skip+restart

Codex 审查结论：最高价值、最低风险。trace_id pattern 已存在，实现成本低。

### 1.2 Tool 分层

目标：TG agent 从 65 个工具砍到 ~15 个核心工具。

实现：
- `registry.mjs` 添加 `group` 参数：`register(def, group)`, `getToolDefs(group)`
- `agent/loop.mjs` 调用 `getToolDefs('tg')` 而不是 `getToolDefs()`
- Pipeline agents 不受影响（已有自己的 scoped tool arrays）

TG agent 核心工具（~15 个）：
- 行情：price, kline_indicators, kline_subscribe, kline_unsubscribe, kline_status
- 交易：positions, balance, open_trade, close_trade
- 分析：status_report, market_scan, tv_market_snapshot, tv_coin_analysis
- 记忆：save_memory, read_memory, search_knowledge
- 系统：system_status

移除的工具仍然注册，但不暴露给 TG agent。

Codex 审查结论：问题比预想的小（pipeline agents 已 scoped），但对 TG agent 仍有明显 token 节省和决策质量提升。

### 1.3 LLM 信号 Pre-filter（而非替换）

目标：在 hardcoded 信号检测后加 LLM 判断层，减少假信号触发。

实现：
- 保留 kline-monitor 的 detectSignals()（EMA cross, MACD cross, RSI extreme, BB, volume spike）
- 信号触发后，先调 gpt-5.4-mini 做 pre-filter："这个信号值得完整分析吗？"
- LLM 说 yes → 触发 pipeline；LLM 说 no → 跳过，只 log
- LLM 超时/失败 → fallback 到原行为（直接触发 pipeline）

Codex 审查结论：不要替换 hardcoded 信号（它们是高精度 trigger），加 pre-filter 是更安全的方案。

## Phase 2: 状态管理（下周）

### 2.1 Pipeline 无状态化（优先）

目标：pipeline.mjs 不再持有内存 state，crash 可恢复。

实现：
- 新建 `pipeline_state` 表（key-value）
- 迁移：cache[mode].analyzing, cache[mode].analysis, cache[mode].lastUpdate
- 同时迁移：cycleCount, patrol 计数器等内存 state
- pipeline 每个 cycle 开始读 DB、结束写 DB

Codex 审查结论：最高价值，是 Phase 3 并行执行的前置。scope 需扩大到覆盖 patrol state。

### 2.2 Session 持久化

目标：用户 24h 后回来，诸葛仍有上下文。

实现：
- 移除 conversation_history 的 1h TTL pruning
- getMessages() 改为：最近 N 轮 + older 的 summary
- Summary 持久化为 event（不再每次重算）
- 添加 retention policy：30 天后归档到 archive 表

Codex 审查结论：可行，但必须加 retention policy 防 DB 无限增长。summary 缓存是关键细节。

### 2.3 Credential 隔离（拆分）

2.3a Vault 存储：
- 从 .env 迁移 BITGET_API_KEY/SECRET/PASS 到加密 vault 文件
- bitget/client.mjs 启动时读 vault
- 加密 key 用 machine-id 派生（无需人工输入，pm2 可自动重启）

2.3b Tool 访问加固：
- 可被 Phase 3 的 lazy tool loading 部分替代（TG agent 不再有 exec_shell）
- 如果保留 exec_shell，添加路径黑名单

Codex 审查结论：拆成两个独立工作。exec_shell 加固是最难的部分。

## Phase 3: AI Native 进化（长期）

### 3.1 Lazy Tool Loading（优先）

目标：按 agent 角色动态加载 tool subset。

实现：
- Tool 定义添加 `category` 元数据
- TG agent 启动时加载 15 个核心工具
- 用户请求需要更多工具时，agent 通过 meta-tool `request_tools(category)` 激活
- Pipeline agents 不变（已 scoped）

Codex 审查结论：高可行性，自然延伸 Phase 1 tool 分层。

### 3.2 Deterministic Self-eval（替代 LLM self-eval）

目标：analyst 输出后做一致性检查。

实现：
- Analyst 输出 parsed → 用 evaluateConditions() 做确定性检查
- 如果 analyst 说 "strong_buy" 但 conditions score < 0.5 → 标记不一致
- 不一致时触发 LLM self-eval（条件性，不是每次都跑）
- 一致时直接进入 risk gate
- Max 1 次 self-eval 迭代

Codex 审查结论：先试确定性方案，比 LLM self-eval 更便宜更可靠。条件性触发控制成本。

### 3.3 Risk + Strategist 并行（小优化，非 phase-level）

目标：analyst 完成后，risk 和 strategist 同时跑。

实现：
- `Promise.allSettled([runRiskCheck(parsed), runStrategistCheck(parsed)])`
- 去掉原计划的 event log 通信（过度工程）
- ~20 行代码改动
- Strategist 内部的 per-trigger risk check 仍然串行

Codex 审查结论：大幅缩小范围。直接 Promise.allSettled，不需要 event log 通信。

### 3.4 DB Retention Policy（新增）

目标：21 张表 + append-only log 不能无限增长。

实现：
- conversation_history: 30 天归档
- pipeline_events: 90 天归档
- candles: 180 天保留
- trades/decisions: 永久保留
- metrics/metrics_snapshots: 30 天 rolling
- 定时任务：每天凌晨跑 archival

## 依赖关系

```
P0 exec_shell fix ──→ 无依赖，立即做
Phase 1.1 Event Log ──→ 无依赖
Phase 1.2 Tool 分层 ──→ 无依赖
Phase 1.3 LLM Pre-filter ──→ 依赖 1.1（event log 记录 pre-filter 结果）
Phase 2.1 无状态 Pipeline ──→ 无依赖，但是 Phase 3.3 的前置
Phase 2.2 Session 持久化 ──→ 无依赖
Phase 2.3a Vault ──→ 无依赖
Phase 2.3b Tool 加固 ──→ 可被 Phase 3.1 替代
Phase 3.1 Lazy Tool ──→ 延伸 Phase 1.2
Phase 3.2 Self-eval ──→ 无依赖
Phase 3.3 并行执行 ──→ 依赖 Phase 2.1
Phase 3.4 DB Retention ──→ 依赖 Phase 2.2
```

## 不做什么

- 不迁移到 Claude Managed Agents 平台（我们自建基础设施，保持控制权）
- 不做真正的分布式 multi-agent（单进程 + Promise.allSettled 够用）
- 不做限价梯子真实成交仿真（wei2.0 已有 ladder 近似）
- 不做 always-in-market 强制常驻仓位（wei1.0 的 probe 策略已近似）
