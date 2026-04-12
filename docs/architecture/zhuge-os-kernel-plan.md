# 诸葛 Agent OS Kernel Plan

更新时间: 2026-04-11
状态: draft v0
依据: Anthropic Managed Agents + @wquguru 五条 + 第一性原理(role-agnostic infra)
取代: `zhuge-refactor-plan.md` + `zhuge-refactor-plan-addendum-2026-04-11.md` 中的 OS 层项

---

## 这份 plan 的边界

**只写 role-agnostic 的 OS kernel。**

- ✅ 在范围内:Event Store / Session / Capability / Brain Adapter / Sanitizer / Vault / Memory / Scheduler / Mandate Gate / Sandbox / Observability / Lifecycle
- ❌ 不在范围内:任何 trader 业务逻辑、任何 agent 的 prompts、任何 tool 的具体实现、任何 K线/Bitget/策略/回测/复盘细节

写 kernel 时**强制不能想 trader**。如果某段设计离了 trader 词汇就描述不清,就是接口不够 generic,必须重写。

trader 专属的事情全部去 `zhuge-trader-harness-plan.md`。AM 来的时候,**理论上 0 改 kernel,只加新 harness**。

---

## 架构

```
┌──────────────────────────────────────────────────────┐
│  Layer 1  Role Harness   (这里有 trader, AM, ...)   │
│  prompts · capabilities-set · mandate · event types  │
│  pipeline · scheduling cadence · system prompts      │
└────────────────────┬─────────────────────────────────┘
                     │ 通过 kernel API 调用,从不绕过
┌────────────────────▼─────────────────────────────────┐
│  Layer 0  Agent OS Kernel   (role-agnostic)          │
│                                                      │
│  Event Store · Session · Capability(Registry+        │
│  Gateway+Brain Adapter) · Sanitizer · Vault ·        │
│  Memory API · Scheduler · Mandate Gate · Sandbox ·   │
│  Observability · Lifecycle/Retention                 │
└──────────────────────────────────────────────────────┘
```

**铁律**:harness 调 kernel 必须经接口,不能 import kernel 内部实现。kernel 任何模块都不允许 import harness。lint/import-graph 检查强制。

---

## 目标文件结构(末态)

```
src/
├── kernel/                    ← role-agnostic OS
│   ├── event-store/
│   │   ├── index.mjs          ← append/getEvents/projection
│   │   └── envelope.mjs       ← generic event envelope
│   ├── session/
│   │   └── index.mjs          ← event-sourced session state
│   ├── capability/
│   │   ├── registry.mjs       ← capability 注册表
│   │   ├── gateway.mjs        ← execute(name, input) 统一入口
│   │   └── adapters/
│   │       ├── openai.mjs     ← brain provider
│   │       ├── anthropic.mjs
│   │       └── gemini.mjs     ← (future)
│   ├── sanitizer/
│   │   └── index.mjs          ← sanitizeForBrain
│   ├── vault/
│   │   └── index.mjs          ← generic secret abstraction
│   ├── memory/
│   │   └── index.mjs          ← read/write/recall API
│   ├── scheduler/
│   │   └── index.mjs          ← cron + event triggers
│   ├── mandate/
│   │   ├── gate.mjs           ← check(action, ctx)
│   │   └── schema.mjs         ← mandate DSL JSON schema
│   ├── sandbox/
│   │   └── index.mjs          ← capability execution backend
│   ├── observability/
│   │   └── index.mjs          ← event → metric/trace 自动化
│   └── lifecycle/
│       └── retention.mjs      ← TTL / archival
│
├── harness/                   ← role-specific
│   ├── trader/                ← 见 trader-harness-plan.md
│   │   ├── mandate.yaml
│   │   ├── prompts/
│   │   ├── capabilities.json
│   │   └── orchestration.mjs
│   └── am/                    ← (future)
│
└── shared/                    ← 既不属于 kernel 也不属于 harness 的共享代码
    ├── bitget/                ← exchange adapter, harness 通过 capability 调
    ├── indicators/            ← 数学函数
    └── llm/                   ← 底层 HTTP 客户端(被 brain adapter 使用)
```

**注**:这是末态,不是一夜搬完。Sprint 2 只迁 trader pipeline 进 harness/trader/,kernel 模块逐个落地后再切关联。

---

## 12 个 Kernel 原语

每个原语统一格式:**目的 → 接口 → 现状/后端 → 验收 → 工时**。

### 1. Event Store

**目的**:append-only 事件日志,所有有意义的状态变化都 emit 一条 event;session 的 state 通过 replay events 重建;crash 之后能 rewind 到任意时刻。

**接口**(role-agnostic envelope)
```js
// kernel/event-store
emit(event: {
  id: ulid,
  type: string,        // harness 自定义,kernel 不解释语义
  ts: iso8601,
  actor: string,       // "harness:trader:analyst" 这种命名空间,kernel 不解析
  trace_id?: string,
  parent_id?: string,
  payload: object      // schema 由 harness 定,kernel 只存
}) → void

getEvents(query: {
  since?: ts,
  until?: ts,
  type?: string|string[],
  actor?: string,
  trace_id?: string,
  limit?: number
}) → AsyncIterator<Event>

project(reducer, query) → state    // 把 events 折叠成投影
```

**关键**:**event type 是字符串,kernel 不知道 `signal_detected` 跟 `rebalance_proposed` 哪个是 trader 哪个是 AM**。harness 自己用,kernel 完全 agnostic。

**后端**:SQLite `events` 表(append-only,index by ts/type/trace_id)。未来可换 PostgreSQL / Kafka,接口不变。

**验收**
- harness 不用任何 trader 词汇也能 emit/query event
- crash 后用 `getEvents` 能完整 reconstruct 上次 session
- benchmark:1M event 表 query by trace_id < 50ms

**工时**:1.5d(schema + 接口 + 测试)

---

### 2. Session

**目的**:取代当前 conversation_history 的 in-memory + TTL 模式。Session = event store 的某个 actor 视角投影 + 当前活跃 context window。

**接口**
```js
session.create(opts) → sessionId
session.append(sessionId, event) → void   // 内部 emit 到 event store
session.getContext(sessionId, opts) → messages[]
  // opts.recent_n + opts.summarize_older
session.rewind(sessionId, ts) → readonly view
session.archive(sessionId) → void
```

**关键**:`getContext` 是**投影函数**,不是直接读 conversation_history 表。底层永远是 event store。这样 rewind/replay/audit 都自动可用。

**后端**:基于 Event Store + 一张 `sessions` metadata 表(sessionId → owner/created/archived)。

**验收**
- 任何 session 任何时刻都能 rewind
- AM 角色的 session 接入时 0 改 kernel
- conversation_history 表迁移完成,旧 1h TTL 删除

**工时**:1d(依赖 Event Store)

**取代**:父 plan 2.2

---

### 3. Capability Registry + Gateway

**目的**:**kernel 最重要的接口**。所有 brain 能调的能力(tool / sub-agent / executor)走同一个 `execute(name, input) → string`。换 brain provider 时 0 改 capability。换 capability 实现时 0 改 brain。

**接口**
```js
// 注册(harness 启动时调)
capability.register({
  name: string,
  description: string,
  input_schema: JSONSchema,
  output_shape: 'string',          // 永远 string,brain 无关返回类型
  handler: async (input, ctx) => string,
  tags?: string[],                 // 用于 lazy loading 的 group filter
  sandbox?: 'in-process' | 'subprocess' | 'wasi',  // 默认 in-process
  mandate_check?: boolean          // 是否过 mandate gate
})

// 调用(brain 通过 gateway 调)
capability.execute(name, input, ctx) → Promise<string>
  // 内部:
  // 1. validate input vs schema
  // 2. 过 sanitizer(防 brain 注入恶意 input)
  // 3. 过 mandate gate(如果 mandate_check=true)
  // 4. 路由到 sandbox 后端
  // 5. emit event {type: 'capability.executed', payload: {name, duration, ok}}
  // 6. truncate output to maxResultChars
  // 7. return string

// brain adapter 用
capability.list(filter) → Schema[]     // 返回 OpenAI/Anthropic 通用中间表示
capability.toBrainFormat(adapter, schemas) → provider-specific format
```

**关键设计点**

- **capability 不区分** tool / sub-agent / executor。Risk 是 capability,Analyst 也是 capability。Sub-agent 只是 capability 的一种 handler 实现。
- **input/output 都是 string-coercible**。brain 不需要知道 capability 内部用什么数据结构。
- **mandate_check 可选**。Read-only capability(查价格)不过 gate;有副作用 capability(下单)必过 gate。
- **sandbox 字段预留**。Sprint 1 全部 in-process,但接口允许未来切后端。

**后端**:in-process Map + JSON schema validator。adapters 子目录里 OpenAI / Anthropic 各一份格式转换器(handle content blocks vs string、tool_use vs tool_calls 差异)。

**验收**
- 切 brain provider(OpenAI ↔ Anthropic)只改 1 个 env var,**不改任何 capability**
- 一段 smoke test 用 anthropic adapter 跑 trader pipeline 一轮,对比 openai adapter,tool 调用序列一致
- AM 角色注册自己的 capabilities 时,kernel 不需要任何修改

**工时**:1d gateway + 0.5d registry + 2d brain adapters(OpenAI + Anthropic)+ 0.5d schema 转换 + 0.5d smoke test = **4.5d**

**取代**:父 plan 1.2、3.1 + addendum 缺项 2

---

### 4. Brain Adapter

**目的**:LLM provider 抽象层。brain "知道有一个 LLM 可调",但**不知道是哪家**。

**接口**
```js
brain.chat(messages, { tools, model, temperature, ... }) → {
  content: string,
  tool_calls: ToolCall[],   // kernel 中间表示
  tokens: { input, output, total },
  finish_reason
}

brain.chatStream(messages, opts) → AsyncIterator<Chunk>
```

**关键**:`messages` 和 `tool_calls` 都是 kernel 内部的中间表示(像 LLVM IR)。adapter 负责:

| Provider | 转换 |
|---|---|
| OpenAI | messages → role/content string,tool_calls → function calling |
| Anthropic | messages → content blocks,tool_calls → tool_use block,system prompt 单独 |
| Gemini | (future) |

**关键**:tool result 在 OpenAI 是 `role:tool` 一条消息,在 Anthropic 是 `tool_result` content block 嵌在 user 消息里。adapter 屏蔽这个差异。

**验收**
- 同一段 messages 通过两个 adapter 调,brain 看到的语义一致
- 切换 adapter 不影响 capability gateway

**工时**:并入 #3 capability(brain adapter 是 capability gateway 的一部分)

---

### 5. Sanitizer

**目的**:任何走出 kernel 进入 LLM provider 的 string,都先过这一层,清洗 secret。

**接口**
```js
sanitizer.scrub(text, opts?) → { text, redactions: [{type, span}] }
sanitizer.scrubMessages(messages) → { messages, redactions }
sanitizer.registerSecret(value, label)   // 启动时注册需保护的实际值
sanitizer.registerPattern(name, regex|fn)
```

**关键设计点**

- **优先级 1**:实际值匹配。启动时把所有 env 中的 secret 实际值注册进来,运行时反查匹配 → 100% 可靠,不依赖 regex 猜格式。
- **优先级 2**:通用 token 模式(sk-, ghp_, AKIA, Bearer 等)
- **优先级 3**:entropy heuristic(长度 + shannon entropy 阈值)
- 命中 → 替换为 `[REDACTED:type]`,emit `sanitizer.redacted` 事件,**事件 payload 只带类型和位置,不带原文**
- 接入位置:`brain.chat` 和 `brain.chatStream` 入口必经,**不依赖 harness 主动调用**

**后端**:in-memory secret set + 正则数组。

**验收**
- 单元测试:fake API key、Bitget secret、TG bot token 全部被替换
- 接入后跑一轮 trader pipeline,redaction count = 0(说明数据流干净)
- redaction 发生时立刻 emit event 告警

**工时**:0.5d 实现 + 0.5d 接入 brain adapter + 0.5d 测试 = **1.5d**

**取代**:addendum 缺项 4

---

### 6. Vault

**目的**:Generic secret 存储,kernel 提供接口,**不知道是 Bitget 还是 OpenAI 还是别的**。

**接口**
```js
vault.get(key) → string         // 同步,kernel/harness 启动时拉一次到内存
vault.list() → string[]         // 仅返回 keys,绝不返回 values
vault.rotate(key, newValue)     // 用于热更新
vault.audit() → AuditLog[]      // 谁在何时读了什么 key
```

**关键**:vault 本身不解 brain credentials —— vault 拿到的所有 value 同时**自动注册到 sanitizer**。任何 vault 里的东西都不会泄漏到 brain prompt。

**后端**:Sprint 1 = 加密文件(machine-id 派生 key)。未来可换 HashiCorp Vault / AWS Secrets Manager。

**验收**
- 启动时所有 secret 从 vault 读
- vault 中任何 secret 出现在 brain prompt 时,sanitizer 必拦截
- vault key 列表可以 list,但 value 不能从外部读出

**工时**:1d

**取代**:父 plan 2.3a

---

### 7. Memory API

**目的**:取代当前 `context.md` 文件直读直写 + Dream Worker 直接编辑文件的模式。Memory 是 kernel 的接口,后端可换。

**接口**
```js
memory.write({
  scope: string,        // namespace,harness 自定 ("trader.context", "am.notes")
  key?: string,         // optional,存 key-value;无 key 则 append
  content: string,
  type: 'context'|'note'|'lesson'|'recall',
  importance?: number,
  ts?: iso8601
}) → memoryId

memory.read(scope, opts?) → Memory[]
memory.recall(query, opts?) → Memory[]    // semantic + keyword
memory.delete(id) → void
memory.archive(scope, before_ts) → archivedCount
```

**关键**:**Dream Worker 不再直接编辑 markdown 文件**。Dream Worker 是一个 harness 层的 capability,内部调 `memory.read` + `memory.write`。文件存储/SQLite/LanceDB/Nowledge Mem 都只是后端实现细节。

**后端**:
- Sprint 1:SQLite 表(或者直接接 Nowledge Mem 已有的 nmem CLI 当后端)
- 未来:LanceDB(向量召回)、Nowledge Mem 远程

**验收**
- harness 不读不写任何 .md 文件,全走 memory API
- AM harness 接入时,自动隔离 scope,trader memory 互不污染
- recall(query) 可以跨 scope 召回(harness 自己决定要不要跨)

**工时**:1d(初版接 SQLite,Nowledge Mem backend 后续)

---

### 8. Scheduler

**目的**:统一的任务触发机制。**取代当前 4 个独立 loop**(pipeline.mjs / market/scanner.mjs / kline-monitor / compound)。

**接口**
```js
scheduler.register({
  name: string,
  trigger: 
    | { type: 'cron', expr: string }           // 定时
    | { type: 'event', match: { type, ... } }  // 事件触发,从 event store 订阅
    | { type: 'signal', source: string }       // 外部信号(WS / webhook)
    | { type: 'manual' },                      // 仅手动触发
  handler: async (ctx) => void,
  concurrency?: number,                         // 同名任务并发上限
  timeout_ms?: number
})

scheduler.trigger(name, payload) → executionId   // 手动触发
scheduler.cancel(executionId)
scheduler.status() → ScheduledTaskStatus[]
```

**关键设计点**

- **不是 OS process scheduler**。是 task scheduler,所有 task 在主进程内 event loop 上跑。
- **event-driven 是一等公民**。`{ trigger: { type: 'event', match: { type: 'signal.kline_breakout' }}}` 让 harness 直接订阅 event store 事件触发任务,不需要轮询。
- 每次执行自动 emit `scheduler.task_started` / `scheduler.task_completed` / `scheduler.task_failed` 事件,纳入 event store。
- **stateless 任务运行时**,任务 handler 不持有 in-memory state,所有状态读写走 event store / memory API。

**后端**:in-process 调度器 + node-cron + event store subscription。

**验收**
- trader 的 4 个 loop 全部迁移到 scheduler.register,源代码 4 个 loop 删除
- AM harness 注册自己的 cadence(月报、季报)时,kernel 0 改
- crash 重启后,scheduler 自动从 event store 恢复未完成任务的状态

**工时**:1.5d 实现 + 1d 迁移 trader 4 loops(此 1d 算到 trader-harness-plan)= **kernel 部分 1.5d**

**取代**:父 plan 2.1 的"无状态"概念部分(具体迁移在 trader plan)

---

### 9. Mandate Gate

**目的**:role-agnostic 的策略约束机制。任何 harness 都能用 DSL 描述自己的硬规则,kernel 提供 check API。

**接口**
```js
mandate.load(harnessName, yamlPath) → mandateId
mandate.check(harnessName, action, context) → {
  pass: boolean,
  veto_reason?: string,
  warnings?: string[]
}
```

**Mandate DSL(JSON Schema)**

```yaml
# 通用 schema,trader / AM / 任何 harness 都用同一份
version: 1
harness: trader
constraints:
  - id: max_position_pct
    when: { action: open_position }
    require: position_pct <= 0.10
    veto_message: "position size {position_pct} > 10% mandate cap"

  - id: forbidden_action
    when: { action: open_position, side: opposite_to_existing }
    veto: true
    veto_message: "reverse open forbidden by mandate"

  - id: dd_circuit_breaker
    when: { action: open_position }
    require: drawdown_24h < 0.05
    veto_message: "24h DD {drawdown_24h} > 5%"

  - id: instrument_whitelist
    when: { action: open_position }
    require: instrument in [BTC-USDT, ETH-USDT, SOL-USDT, ...]
    veto_message: "instrument {instrument} not in mandate whitelist"
```

**关键**:DSL 不写 trader 词汇。`action`、`context`、`require` 都是 generic 表达。trader 写 `action: open_position`,AM 写 `action: rebalance`。kernel 不解析语义。

**关键**:capability gateway 调用任何 `mandate_check: true` 的 capability 之前自动过 mandate gate,不需要 capability handler 主动调。

**后端**:JSON schema validator + JS expression evaluator(如 jexl 或自写小 DSL)。

**验收**
- trader.mandate.yaml 完全描述当前 risk.mjs 的 hard rules
- check 一个反向开仓 action → 必 veto
- AM 角色 mandate.yaml 接入时 kernel 0 改

**工时**:1d 接口 + 0.5d expression evaluator + 0.5d 测试 = **2d**

---

### 10. Sandbox

**目的**:capability 执行的隔离层。Sprint 1 不真做 OS-level 隔离,**只把接口预留好**,未来可换 subprocess / WASI / Docker 后端。

**接口**
```js
sandbox.run(handler, input, opts?) → string
  // opts.timeout_ms / opts.memory_limit_mb / opts.allow_network ...

sandbox.backends → ['in-process']  // Sprint 1 只有这一个
```

**关键**:capability 注册时声明 `sandbox: 'in-process' | 'subprocess' | 'wasi'`,gateway 路由。**未来要跑不可信代码时(比如 AM 让用户上传策略),直接换后端,capability 注册不动**。

**后端**:Sprint 1 = 直接 await handler。Sprint 4+ 可加 subprocess。

**验收**
- 接口存在,所有 capability 都标记 sandbox 字段(默认 in-process)
- 未来切后端时不需要改 capability 实现

**工时**:0.5d(只接口和默认实现)

---

### 11. Observability Primitives

**目的**:event store → metrics → traces → dashboard 的自动化管道。harness 不再手动 record metric,只 emit event。

**接口**
```js
observability.subscribe({
  event_type: string,
  reducer: (event) => { metric, labels, value }
}) → subscriptionId
```

**关键**:每条 event 自动产出 metric / span / log。例如:
- event `capability.executed` → metric `capability_latency_ms{name, ok}` + Jaeger span
- event `mandate.veto` → metric `mandate_veto_total{rule_id}`
- event `sanitizer.redacted` → metric `sanitizer_redactions_total{type}`

**后端**:订阅 event store,转 Prometheus + OTel 已有的 exporter。

**验收**
- harness 代码里不再有手动 `metrics.record(...)` 调用
- 加新 event type 不需要改 dashboard 代码,只需注册新 subscriber

**工时**:1d(基础订阅 + 现有 metric 迁移分散在 trader plan)

---

### 12. Lifecycle / Retention

**目的**:event store / session / memory 的 TTL + 归档,防 SQLite 撑爆。

**接口**
```js
lifecycle.policy({
  scope: string,             // 'events:<type>' | 'sessions' | 'memory:<scope>'
  retention: duration,
  archive_to?: 'archive_table' | 'cold_storage',
  delete_after?: duration
})
```

**关键**:由 scheduler 触发,每天/每周跑一次。

**默认 policy(kernel ships with)**
- `events:*` → 90 天 archive,180 天 delete
- `sessions:*` → 30 天 archive
- `memory:context` → 永久(harness 自己决定)
- `memory:lesson` → 永久
- `sanitizer.redacted` event → 30 天

**验收**
- 能配置任意 policy
- archival job 自动注册到 scheduler

**工时**:0.5d

**取代**:父 plan 3.4

---

## 工时汇总

| # | 原语 | 工时 |
|---|---|---|
| 1 | Event Store | 1.5d |
| 2 | Session | 1d |
| 3 | Capability Registry + Gateway | 4.5d(含 brain adapters) |
| 4 | Brain Adapter | (并入 #3) |
| 5 | Sanitizer | 1.5d |
| 6 | Vault | 1d |
| 7 | Memory API | 1d |
| 8 | Scheduler | 1.5d |
| 9 | Mandate Gate | 2d |
| 10 | Sandbox(接口预留) | 0.5d |
| 11 | Observability | 1d |
| 12 | Lifecycle | 0.5d |
| **合计** | | **16d** |

**注**:这是 kernel 实现工时,不含 trader harness 迁移到 kernel 的时间(在 trader-harness-plan)。

---

## Sprint 切分

### Sprint 1:OS 最小内核(7d)

最小可用集 —— 让 trader 能跑在 kernel 上的最小原语。

- Event Store(1.5d)
- Capability Registry + Gateway + 1 个 OpenAI brain adapter(3d 部分)
- Sanitizer(1.5d)
- Vault(1d)

**到此**:trader pipeline 还在原地,但 capability 调用走 kernel 了,secret 安全了,event 开始记录了。

### Sprint 2:Mandate + Memory + Session(5d)

- Mandate Gate(2d)
- Memory API(1d)
- Session(1d)
- Anthropic brain adapter(1d,补 #3 剩余)

**到此**:trader 的 mandate 可以独立成 yaml,Risk 规则审计有锚点(那是 trader plan 的事了,这里只提供能力)。

### Sprint 3:Scheduler + Observability + Lifecycle(3.5d)

- Scheduler(1.5d)
- Observability(1d)
- Lifecycle(0.5d)
- Sandbox 接口(0.5d)

**到此**:kernel 完整。trader harness plan 此时进入"把现有 7 agent 迁移到 kernel" 阶段。

---

## 不做什么(明确 out of scope)

- ❌ 不做 OS-level 隔离(subprocess / WASI / Docker)—— 接口预留,实现等真有不可信代码时再加
- ❌ 不做 brain failover(provider down 自动切)—— 手动切就够,quota 不一致是噪声
- ❌ 不做分布式 / RPC kernel —— 单进程 in-memory + SQLite 就行
- ❌ 不做 capability marketplace / hot-swap 加载 —— 启动时全部注册
- ❌ 不做"通用 RAG"原语 —— Memory API 的 recall 由后端决定,kernel 不规定召回算法
- ❌ 不做事件驱动的 saga / orchestration framework —— scheduler 已经够,过度设计会失控

---

## 验收(整套 kernel 完成的标志)

1. **role-agnostic 测试**:写一个 hello-world harness(`harness/echo/`),只暴露一个 `say_hello` capability,跑通 capability gateway / brain adapter / event store / mandate gate(空 mandate)/ memory(notes only)/ scheduler(cron)。代码量 < 200 行。
2. **brain swap 测试**:trader pipeline 跑一轮,环境变量切 OpenAI ↔ Anthropic,tool 调用序列等价(允许文本差异)。
3. **import-graph 检查**:`harness/` 不能 import `kernel/` 内部模块,只能通过 kernel 顶层 export。`kernel/` 任何地方不能 import `harness/`。CI 强制。
4. **AM dry-run**:不写 AM 实际功能,只起一个 `harness/am/mandate.yaml` + 注册一个 `rebalance` capability + scheduler 月度 cron,kernel 不需要任何修改就能跑起来(空实现)。

---

## 与父 plan 和 addendum 的关系

| 父 plan / addendum 项 | 在本 kernel plan 中的归属 |
|---|---|
| P0 exec_shell 加固 | 属于 Sandbox 接口的精神,已做 |
| 1.1 Event Log | 原语 #1 Event Store(generic 化) |
| 1.2 Tool 分层 | 部分进 #3 Capability(group filter)+ 部分进 trader plan(具体 tool 列表) |
| 1.3 LLM Pre-filter | 全部进 trader plan |
| 2.1 无状态 Pipeline | 概念进 #8 Scheduler(stateless 任务模型),具体迁移进 trader plan |
| 2.2 Session 持久化 | 原语 #2 Session |
| 2.3a Vault | 原语 #6 Vault(generic 化) |
| 2.3b Tool 加固 | 属于 Sanitizer / Sandbox |
| 3.1 Lazy Tool Loading | 进 #3 Capability(group filter) |
| 3.2 Deterministic Self-eval | 全部进 trader plan |
| 3.3 Risk + Strategist 并行 | 全部进 trader plan |
| 3.4 DB Retention | 原语 #12 Lifecycle |
| addendum 缺项 1 Risk 审计 | 进 trader plan,改成"填 mandate.yaml" |
| addendum 缺项 2 Capability gateway | 原语 #3 |
| addendum 缺项 3 K线 pre-filter 并行 | 进 trader plan |
| addendum 缺项 4 Sanitizer | 原语 #5 |

旧的两份 plan 已加 deprecation banner,保留作为历史。
