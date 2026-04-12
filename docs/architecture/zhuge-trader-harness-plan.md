# 诸葛 Trader Harness Plan

更新时间: 2026-04-11
状态: draft v0
依据: zhuge-os-kernel-plan.md(role-agnostic kernel)+ 现有 trader 业务
取代: `zhuge-refactor-plan.md` + `zhuge-refactor-plan-addendum-2026-04-11.md` 中的 trader 业务项

---

## 这份 plan 的边界

**只写 trader 角色**作为一个 harness 怎么搭在 kernel 上、以及 trader 自己的业务优化。

- ✅ 在范围内:trader.mandate.yaml 落地 / trader prompts 整理 / trader capabilities 注册 / trader pipeline 迁移到 kernel scheduler / Risk 规则审计成 mandate / K线 pre-filter / strategy lifecycle / 7 个 agent 的具体调整
- ❌ 不在范围内:任何 OS 原语的设计(去 kernel plan)、任何 capability gateway 的实现细节(去 kernel plan)、任何 brain adapter 的格式问题(去 kernel plan)

**前置依赖**:zhuge-os-kernel-plan.md 的 Sprint 1-3 完成。本 plan 假设 kernel 12 个原语都可用。

---

## Trader 作为 harness 的"完整定义"

一个 harness = 5 样东西:

1. **mandate.yaml** —— 这个角色的硬规则
2. **capabilities.json** —— 这个角色能调的能力清单(从 kernel registry 里挑)
3. **prompts/** —— 这个角色每个 sub-agent 的 system prompt
4. **orchestration.mjs** —— 这个角色的任务编排逻辑(注册到 kernel scheduler)
5. **event-types.md** —— 这个角色 emit 的事件类型清单(给 observability 订阅用)

末态目录:

```
src/harness/trader/
├── mandate.yaml
├── capabilities.json
├── prompts/
│   ├── analyst.md
│   ├── risk.md
│   ├── strategist.md
│   ├── researcher.md
│   ├── reviewer.md
│   ├── runner.md
│   └── compound.md
├── orchestration.mjs       ← 注册 schedule + 编排
├── capabilities/           ← trader 专属 capability handler
│   ├── open_trade.mjs
│   ├── close_trade.mjs
│   ├── get_position.mjs
│   ├── get_balance.mjs
│   ├── kline_*.mjs
│   ├── tradingview_*.mjs
│   ├── score_contract.mjs   ← 原 researcher
│   ├── analyze_market.mjs   ← 原 analyst
│   ├── propose_strategy.mjs ← 原 strategist
│   └── ...
└── event-types.md
```

---

## Sprint A:Mandate 化(Sprint 1 后启动)

### A.1 写 trader.mandate.yaml

把当前 `agents/risk.mjs` 第 13-31 行的 hard rules + DB-side 检测 + scanner/executor 隐藏护栏,**全部表达成 mandate DSL**。

具体步骤:

1. 把所有现存的硬规则**列成审计表**,在 `docs/architecture/risk-rule-audit.md`,4 列:`source_file:line | rule | category(A真invariant / B模型补丁 / ?未定) | mandate-expressible`
2. A 类全部写进 `trader.mandate.yaml`(走 mandate gate)
3. B 类写成 prompt block(注入到 analyst/risk system prompt),**不再硬编码**;同时加 feature flag `config.trader.legacy_llm_guards`(默认 ON,14 天后看数据决定关不关)
4. ? 类先标记,随实现深入再分类

**初版 trader.mandate.yaml 样板**(需要审计后填)

```yaml
version: 1
harness: trader
description: TradeAgent 诸葛默认 mandate

constraints:
  - id: max_24h_loss
    when: { action: open_position }
    require: drawdown_24h < 0.05
    veto_message: "24h DD {drawdown_24h} > 5% mandate cap"

  - id: max_consecutive_losses
    when: { action: open_position }
    require: consecutive_losses < 3
    veto_message: "3 consecutive losses, 1h cooldown required"

  - id: instrument_whitelist
    when: { action: open_position }
    require: instrument in mandate.allowed_instruments
    veto_message: "instrument {instrument} not allowed"

  - id: max_leverage
    when: { action: open_position }
    require: leverage <= 10
    veto_message: "leverage {leverage} exceeds cap 10"

  - id: max_position_pct
    when: { action: open_position }
    require: position_pct <= 0.10
    veto_message: "position {position_pct} > 10% portfolio"

  - id: no_reverse_open
    when:
      action: open_position
      side: opposite_to_existing_in_same_instrument
    veto: true
    veto_message: "reverse open forbidden — close existing first"

  - id: balance_floor
    when: { action: open_position }
    require: account_balance_usdt > 50
    veto_message: "balance too low to execute"

allowed_instruments:
  - BTC-USDT
  - ETH-USDT
  - SOL-USDT
  - BNB-USDT
  # ... 由 trader 维护,不进 mandate hard rules
```

**取代**:addendum 缺项 1(完全替代,不再需要"feature flag 双轨"那套 —— mandate gate 本身就是统一执行点)

**工时**:1d 审计 + 0.5d 写 yaml + 0.5d 接 mandate gate 验证 = **2d**

### A.2 删除 risk.mjs 里被 mandate 取代的代码

- 移除 `RISK_SYSTEM_PROMPT` 中已迁出的硬规则文字(避免双轨语义不一致)
- 移除 `get_trade_stats` 内部的 24h loss / consecutive losses 检测(改成只查询数据,判断由 mandate gate 做)
- 保留 risk.mjs 作为 capability(`risk.evaluate`),但它的角色变成"做软判断,生成 risk_flags 给 strategist 参考",不再做硬 veto

**工时**:0.5d

### A.3 删除 scanner/executor 里的隐藏护栏

把 `market/scanner.mjs` / `bitget/executor.mjs` 里散落的"同向持仓跳过"、"杠杆上限"等硬规则,**全部走 mandate gate**(capability `open_position` 的 mandate_check=true)。

**工时**:0.5d

**Sprint A 总计**:**3d**

---

## Sprint B:Capability 迁移(Sprint 1 capability gateway 就绪后启动)

### B.1 注册 trader capabilities

把当前 `agent/tools/data.mjs / memory.mjs / schedule.mjs / system.mjs / trade.mjs / tradingview.mjs` 里的 65 个 tool **全部注册到 kernel capability registry**。

每个 tool 转成 kernel capability 注册项:

```js
// harness/trader/orchestration.mjs(启动时)
import { capability } from 'kernel/capability'

capability.register({
  name: 'trader.open_position',
  description: '...',
  input_schema: {...},
  handler: async (input, ctx) => { /* 原 trade.mjs 实现 */ },
  tags: ['trader', 'trade', 'destructive'],
  mandate_check: true,            // 必过 mandate gate
  sandbox: 'in-process'
})
```

**关键变化**

- 名字改成 `trader.*` 命名空间
- `mandate_check` 字段决定哪些过 gate
- tag 为 lazy loading 准备
- 老代码 `agent/tools/registry.mjs` 整个删除(被 kernel capability registry 替代)

**工时**:1d(主要是机械迁移,逻辑不变)

### B.2 trader 角色的 capability bundle

写 `harness/trader/capabilities.json`,定义 trader 默认暴露给 brain 的 capability 子集(对应父 plan 1.2 提到的 ~15 个核心 tool)。

```json
{
  "tg_agent_default": [
    "trader.price",
    "trader.kline_indicators",
    "trader.kline_subscribe",
    "trader.positions",
    "trader.balance",
    "trader.open_position",
    "trader.close_position",
    "trader.status_report",
    "trader.market_scan",
    "trader.tv_market_snapshot",
    "trader.save_memory",
    "trader.read_memory",
    "trader.search_knowledge",
    "trader.system_status"
  ],
  "tg_agent_extended": [
    "*"
  ],
  "pipeline_analyst": [
    "trader.get_crucix_data",
    "trader.get_crypto_news",
    "trader.kline_indicators",
    ...
  ]
}
```

`agent/loop.mjs` 里的 `executor.getToolDefs()` 改成 `capability.list({ filter: bundle })`。

**取代**:父 plan 1.2(完整替代)+ 父 plan 3.1 lazy loading(meta-tool `request_tools` 留作 Sprint D 优化)

**工时**:0.5d

### B.3 Tool executor 返回值规范化

所有 capability handler 必须返回 `{ ok, data?, error? }` 的 JSON.stringify。当前混着 throw / `JSON.stringify({error})` / 裸字符串的情况,趁迁移一次性统一。

**工时**:0.5d

**Sprint B 总计**:**2d**

---

## Sprint C:Pipeline 上 Scheduler(Sprint 3 scheduler 就绪后启动)

### C.1 拆解 4 个独立 loop

| 现状 | 迁移到 kernel scheduler |
|---|---|
| `pipeline.mjs` 主 loop(crypto + stock 两 cycle) | `scheduler.register({ name: 'trader.cycle.crypto', trigger: { type: 'cron', expr: '*/15 * * * *' }, handler: runCryptoCycle })` 类似 stock |
| `market/scanner.mjs` momentum loop | `scheduler.register({ name: 'trader.momentum_scan', trigger: { type: 'cron', expr: '*/3 * * * *' }, handler: scanMomentum })` |
| `kline-monitor` 信号循环 | 两步:(1) 一个 `trader.kline_ws` 任务,trigger=signal,handler 把 WS 信号转成 event store 事件 `trader.signal.kline_breakout`(2) `trader.kline_react` 任务,trigger=event,match 上面的 event type,handler 调 pipeline 分析 |
| `compound` reflection loop | `scheduler.register({ name: 'trader.compound_reflect', trigger: { type: 'cron', expr: '0 */6 * * *' }, handler: runCompound })` |

**关键收益**

- 4 个 loop 删除,统一 schedule
- crash 后自动 resume(scheduler 从 event store 恢复)
- 加新 cadence 不需要写新 loop
- AM 角色未来同样用 scheduler.register

### C.2 任务 stateless 化

每个 handler 不持 in-memory state。当前 `pipeline.mjs` 的 `cache[mode].analyzing/analysis/lastUpdate` + `cycleCount` + patrol 计数器,**全部迁到 event store / memory API**。

handler 启动时:
- 从 event store 读最后一个 `trader.cycle.completed` 事件 → 恢复进度
- 从 memory(`trader.context`)读最近一次分析结果

handler 结束时:
- emit `trader.cycle.completed` 事件
- 把 analysis 结果写 memory

**取代**:父 plan 2.1(完整替代,迁移到 kernel scheduler 而不是自建 pipeline_state 表)

**工时**:1.5d 拆 loop + 1d stateless 化 + 0.5d crash recovery 测试 = **3d**

---

## Sprint D:Trader 业务优化(Sprint A/B/C 完成后)

这一段是父 plan 里被分散的 trader-flavored 业务项的统一收纳。**前面 3 个 sprint 完成后,这些都建在 kernel 之上**。

### D.1 LLM Signal Pre-filter(原父 1.3)

在 `trader.kline_react` handler 里,信号触发 → pipeline 分析 之前加一层 LLM 调用:"这个信号值得完整分析吗?"

**实现**

- 用 `capability.execute('trader.prefilter_signal', { signal_payload })`,handler 内部调 brain 一次低成本 prompt
- 多 symbol 同时触发时,**用 `Promise.allSettled` + p-limit(concurrency=4)** 并发执行(原 addendum 缺项 3 修订版)
- LLM 超时 → fallback 直接进入完整分析(不阻塞)
- emit 事件 `trader.signal.prefilter_passed` / `trader.signal.prefilter_skipped`,计入 metric

**取代**:父 plan 1.3 + addendum 缺项 3

**工时**:1d 实现 + 0.5d 调优 = **1.5d**

### D.2 Deterministic Self-eval(原父 3.2)

Analyst 输出 → 用 `conditions.mjs` 做确定性一致性检查 → 不一致才触发 LLM self-eval(条件性,不每次)。

**实现**

- 现 `backtest/conditions.mjs` 的 `evaluateConditions` 复用
- 接入位置:`pipeline.mjs` analyst 结果 parse 之后、过 mandate gate 之前
- 不一致 → emit `trader.analyst.inconsistency_detected` → LLM self-eval(max 1 次)

**取代**:父 plan 3.2

**工时**:1d

### D.3 Risk + Strategist 并行(原父 3.3)

`Promise.allSettled([runRiskCheck, runStrategistCheck])`,~20 行。前提是它们对 analyst output 是只读的(查一下两边代码确认)。

**取代**:父 plan 3.3

**工时**:0.5d

### D.4 Strategy Lifecycle(新增)

当前 strategy state 只有 `proposed → active`。补一个完整的生命周期,**为未来 AM 化做准备,但 trader 现在就能受益**。

**状态机**

```
draft           ← compound 刚生成
  ↓ (条件评估通过)
incubation      ← 跟踪条件触发,不真交易,只 log
  ↓ (生存 N 天且条件触发 ≥ M 次)
paper_trading   ← 真触发,真生成 trade plan,但不下单,只算 P&L
  ↓ (paper P&L > threshold)
scout_live      ← 用最小仓位真下单
  ↓ (scout 胜率/Sharpe 达标)
live            ← 正常仓位
  ↓ (任意阶段表现差)
throttled       ← 暂停新单,持仓出场
  ↓ 
retired
```

**实现**

- 新表 `strategy_lifecycle`(state, since, transitions JSON)
- compound 生成新策略时进 `draft`
- 每次 cycle 评估时根据条件推进
- mandate.yaml 加约束:`require: strategy_state in [scout_live, live]`(不允许 incubation/paper 状态的策略下单)

**工时**:1d 状态机 + 0.5d 接入 = **1.5d**

### D.5 Trade Thesis 三件套(新增,极小成本)

每次 open_position capability 调用必须带:

```json
{
  "expected_scenario": "BTC 突破 70k 后冲刺 72k",
  "invalidation": "若 5min 收回 69.5k 以下则失败",
  "exit_plan": "TP 71500 SL 69400 / max hold 4h"
}
```

存入 trade 表 / event store。复盘时 reviewer 用这三个字段判断"错在 thesis 还是错在 execution"。

**为什么算 trader plan 而不是 AM plan**:thesis 是任何 trader 都该有的纪律,不是 AM 专属。

**工时**:0.5d schema + 0.5d 接入 strategist/executor + 0.5d reviewer 用起来 = **1.5d**

**Sprint D 总计**:**6d**

---

## Sprint E:历史数据迁移与清理

Sprint A/B/C 完成后做。

### E.1 Conversation history 迁移

旧 `conversation_history` 表的 1h TTL 数据搬入 kernel session(基于 event store)。同时跑一次 sanitizer 扫描,清掉历史脏数据(防 secret 残留)。

**取代**:addendum 盲点 #2

**工时**:0.5d 脚本 + 0.5d dry-run 验证 = **1d**

### E.2 删除被 kernel 替代的旧文件

整理一份"可删除文件"清单:

- `agent/tools/registry.mjs`(被 kernel capability registry 替代)
- `agent/tools/executor.mjs`(被 kernel capability gateway 替代)
- `agents/message-bus.mjs` 部分功能(被 event store 替代,如果 message-bus 还有非 event 用法保留)
- `pipeline.mjs` 的 4 个独立 loop(被 scheduler 替代,handler 留下)
- `agents/risk.mjs` 的 hard rules 部分(被 mandate 替代)

**工时**:0.5d 清理 + 0.5d 跑测试确认 = **1d**

**Sprint E 总计**:**2d**

---

## 总工时

| Sprint | 内容 | 工时 |
|---|---|---|
| A | Mandate 化 | 3d |
| B | Capability 迁移 | 2d |
| C | Pipeline 上 Scheduler | 3d |
| D | Trader 业务优化(pre-filter / self-eval / parallel / lifecycle / thesis) | 6d |
| E | 历史数据迁移与清理 | 2d |
| **合计** | | **16d** |

加上 kernel plan 的 **16d**,总计 **32 人日**。

**对比父 plan + addendum 原估算**:父 plan 没给精确工时,我估约 12-15d;addendum +8d。合 20-23d。

**新结构 32d 比旧的多 ~10d。多出来的钱花在哪里?**

- Mandate Gate 原语 + DSL(2d,旧 plan 里没有)
- Memory API(1d,旧 plan 里硬编码 markdown)
- Scheduler(1.5d,旧 plan 里只改 trader pipeline,新 plan 替换全部 loop)
- Strategy Lifecycle(1.5d,旧 plan 里没有)
- Trade Thesis(1.5d,旧 plan 里没有)
- Capability format 转换 / brain adapter 多 provider(2-3d,旧 plan 没真考虑换 brain)

**这 10d 换来的是**:role-agnostic 的 OS,加 AM 时 0 改 kernel,trader 自身也更专业。**贵但值**。

---

## Sprint 之间的依赖

```
kernel Sprint 1   (event store + capability + sanitizer + vault)
   │
   ├──→ trader Sprint A (mandate 化, 需要 mandate gate 接口 → kernel Sprint 2)
   │       └─ 实际上 A 等到 kernel Sprint 2 完成
   │
   ├──→ trader Sprint B (capability 迁移, 需要 capability gateway = kernel Sprint 1 完成即可)
   │
   └──→ kernel Sprint 2  (mandate + memory + session + Anthropic adapter)
            │
            ├──→ trader Sprint A 启动
            │
            └──→ kernel Sprint 3  (scheduler + observability + lifecycle + sandbox)
                     │
                     └──→ trader Sprint C (pipeline 上 scheduler)
                             │
                             └──→ trader Sprint D (业务优化)
                                     │
                                     └──→ trader Sprint E (清理)
```

**最短路径**:kernel S1 → kernel S2 + trader B 并行 → kernel S3 + trader A 并行 → trader C → trader D → trader E

---

## 验收(整套 trader harness 完成的标志)

1. **mandate-driven**:任何 risk veto 都能 trace 到 `trader.mandate.yaml` 的某条规则;`agents/risk.mjs` 不再有硬编码 reject 分支
2. **capability-only**:trader 没有 import `kernel/` 内部模块,只通过 `capability.register / execute` 接触 kernel
3. **scheduler-only**:`pipeline.mjs` / `market/scanner.mjs` / `kline-monitor` / `compound` 的 loop 全部删除,任务跑在 kernel scheduler
4. **brain-swappable**:env 切 OpenAI ↔ Anthropic,trader 仍工作,所有 7 agent 跑通
5. **stateless**:kill -9 + 重启,不丢任何决策状态(从 event store 恢复)
6. **observability auto**:dashboard 没有手动 record metric,全靠 event store 订阅
7. **每笔 open_position 都带 thesis 三件套**

---

## 不做什么

- ❌ 不做 portfolio constructor(组合视角属于 AM 范畴,trader 保持单笔决策模型)
- ❌ 不做 performance attribution(α/β 拆解属于 AM)
- ❌ 不做 IPS 文档(mandate.yaml 已经覆盖 trader 自营场景的需要)
- ❌ 不做 client/principal 模型(自营,无客户)
- ❌ 不做 mandate-bound 周报(那是 AM)
- ❌ 不做 strategy lifecycle 的真实 paper trading 引擎(用历史回测代替 N 天 paper)
