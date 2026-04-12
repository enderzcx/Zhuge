# 诸葛架构重构计划 — Addendum 2026-04-11

> ⚠️ **DEPRECATED 同日 2026-04-11**(写完几小时后) —— 本文档已被以下两份替代:
> - `zhuge-os-kernel-plan.md`
> - `zhuge-trader-harness-plan.md`
>
> **为什么换**:用户提出"infra 应该 role-agnostic,trader/AM 都是 harness"的更深层要求,本 addendum 仍然把 OS 项和 trader 项混在一起,而且缺 4 个核心 OS 原语(Mandate Gate / Scheduler / Memory API / Sandbox)。重构后 kernel/harness 分层。本 addendum 的 4 个缺项归属:
> - 缺项 1(Risk 审计)→ trader plan Sprint A(Mandate 化)
> - 缺项 2(Capability gateway)→ kernel plan 原语 #3
> - 缺项 3(K线 pre-filter 并行)→ trader plan Sprint D.1
> - 缺项 4(Sanitizer)→ kernel plan 原语 #5
>
> **历史地位**:保留作为"自查发现 plan 错位"的演进记录。其中"缺项 3 错误前提"的自查教训仍然有效,搬到了 trader plan D.1 的实施备注里。

---

更新时间: 2026-04-11
状态: draft, self-reviewed(codex 环境故障跳过) → **deprecated 同日**
父文档: `zhuge-refactor-plan.md` (2026-04-09, codex-reviewed approved)
触发: 重读 Anthropic Managed Agents + @wquguru 五条总结后,发现父 plan 缺的事。

## 自查修订(2026-04-11 午)

首稿写完后人工核对源码,发现/修正以下问题:

- **缺项 3 (Scanner Many-Brains) 基于错误前提,已删除**。Scanner 实际只对 `candidates.slice(0, 3)` 做 LLM research(market/scanner.mjs:371),540+ 只是 Bitget public ticker 的批量过滤,根本没有 LLM 串行瓶颈。改为 "缺项 3 (修订): K 线 Pre-filter 并行化"
- 缺项 1 估算 2d → **3d**(漏算了 scanner/executor 里的隐藏护栏)
- 缺项 2 估算 3d → **4.5d**(漏算 Anthropic content-block vs OpenAI string 的 history 转换成本),且删掉"先于 Phase 1.2"的硬排序
- 缺项 4 补充了 Bitget key pattern 和 pipeline.mjs 接入点
- 新增盲点清单(event log retention、历史脏数据迁移、tool executor 返回值规范化)

---

## 进度核对(2026-04-09 → 04-11)

| 项目 | 状态 | 提交 |
|------|------|------|
| P0 exec_shell + read_file 加固 | ✅ done | f372477 |
| HTTP 绑 127.0.0.1 | ✅ done(bonus) | 2f7c60c |
| Phase 1.1 Event Log | ❌ pending | — |
| Phase 1.2 Tool 分层 | ❌ pending | — |
| Phase 1.3 LLM Pre-filter | ❌ pending | — |
| Phase 2.1 无状态 Pipeline | ❌ pending | — |
| Phase 2.2 Session 持久化 | ❌ pending | — |
| Phase 2.3a Vault | ❌ pending | — |
| Phase 3.* | ❌ pending | — |

**结论**:父 plan 只完成了 P0,主体未动。本 addendum 不重排 Phase 1/2/3,只补缺,并校正 Phase 1.1 的范围让它把新增项目顺带覆盖。

---

## 缺项 1:Risk 规则审计 — 区分真 invariant vs 模型补丁

**问题**

`agents/risk.mjs` 当前是 fail-closed 的硬编码规则集合。这些规则混了两种东西:

- **A 类(真 invariant)**:无论模型多强都该有 — 单笔仓位上限、对账失败必须停、永远不开反向单覆盖现仓
- **B 类(模型补丁)**:只是因为当前 LLM 偶尔会幻觉 — "如果 strategist 说做空但 analyst 没提到任何 bearish signal,reject"

把 B 类硬编码进代码,正是 @wquguru 总结的第 1 条反模式 ——「把当前模型弱点写死在基础设施里」。半年后模型变强,这些规则会变成**负优化**(拒掉本该执行的好交易,且无法 A/B 测试是否仍需要)。

**做法**

1. 把 `agents/risk.mjs` 的所有 reject 分支列出来,做一遍人工分类(A / B / 不确定)
2. 输出 `docs/architecture/risk-rule-audit.md`,每条规则记 4 列:`condition | rationale | category(A/B/?) | promote-to-prompt-feasible`
3. B 类规则**不立刻删**,而是改成可关闭的 feature flag(`config.risk.legacy_llm_guards = true|false`),并把规则文本同步写进 strategist/analyst 的 system prompt(让模型自己学这条约束)
4. 上线 14 天后,统计 A/B(开 vs 关)的拒单次数 + 后向收益差,若关了不变差,从代码删除

**为什么不直接 prompt 化**:风险太集中。先双轨,数据驱动决策。

**接受标准**

- 审计文档完成,所有规则有归类
- 至少 50% 的 B 类规则已加 feature flag 且默认 ON
- 监控 dashboard 加 `risk_reject_total{category="A|B"}` label

**估算**:1d 审计(含 scanner/executor 隐藏护栏梳理) + 0.5d feature flag + 1d 监控 + 0.5d 14 天后数据复盘收尾 = **3 人日**(分两段,T0 + T14)

**核对过的规则源(自查)**

- `agents/risk.mjs:13-31` system prompt 里的 3 条 hard + 3 条 soft
- `agents/risk.mjs:70-80` get_trade_stats 的 24h loss / consecutive loss / account balance 检测(DB-side hard rule)
- `market/scanner.mjs` scalePosition / scout 路径里的"同向持仓跳过"(隐藏护栏)
- `bitget/executor.mjs` 的仓位上限 / 杠杆上限(可能存在的冗余 hard rule)
- `pipeline.mjs` 对 `close` action 的映射防 short 反向(CLAUDE.md 明确提到过的坑)

---

## 缺项 2:Capability 接口标准化 — Brain 可替换

**问题**

父 plan 的 1.2/3.1 解决「TG agent 工具太多」,但没解决**「换 LLM provider 要改多少地方」**这个更根本的问题。

诸葛今天的工具调用链是:

```
agent/loop.mjs → llm.mjs → openai-compatible API
                       ↓
                  registry.mjs → 直接 import 各 tool 函数
```

如果想换 brain(从 gpt-5.4 → claude-5 → gemini-3),要改:
- `llm.mjs` 的 provider 调用
- `registry.mjs` tool schema 格式(各 provider 的 function calling 格式不同)
- `agent/loop.mjs` 的 message 拼装
- 流式响应解析

这违背 Anthropic 文章核心 ——「**接口越薄越能扛迭代**」。

**做法**

引入一层 capability gateway,**所有内部能力(tools / sub-agents / executors)走同一个 `execute(name, input) → string` 接口**:

```js
// agent/capability/gateway.mjs (新)
export async function executeCapability(name, input, ctx) {
  // 1. 查 registry,定位 capability
  // 2. validate input via JSON schema
  // 3. 路由到 tool / sub-agent / executor
  // 4. 统一 emit event(对接缺项 1.1 event log)
  // 5. 返回字符串(brain 不需要知道返回类型)
}
```

Brain 侧:`llm.mjs` 改成 provider adapter(openai/anthropic/google 三个 adapter,共享同一个 capability gateway)。换 brain 只改 adapter 文件,**registry 和 tool 实现完全不动**。

**接受标准**

- 一个新文件 `agent/capability/gateway.mjs`,所有 tool 调用都走它
- `llm.mjs` 拆成 `llm/openai.mjs`、`llm/anthropic.mjs`,通过 env var 切换
- 写一个 smoke test:`npm run test:brain-swap` 用 anthropic adapter 跑一遍 pipeline,确认结果与 openai 一致(允许文本差异,但 tool 调用序列应一致)

**估算**:1d gateway + 2d provider adapter(OpenAI ↔ Anthropic history 格式互转是难点 —— content blocks vs string、tool_use vs tool_calls、system prompt 位置不同)+ 0.5d tool executor 返回值规范化(前置,见盲点 3) + 1d smoke test = **4.5 人日**

**依赖**:无。与 Phase 1.2(tool 分层)**正交**,不需要硬排序 —— 1.2 改 registry 的 group filter,gateway 改 provider adapter,两者互不影响。首稿里写的"建议先于 1.2"撤回。

---

## 缺项 3(修订):K 线 Pre-filter 并行化

**首稿错误**

首稿声称 "Scanner 串行扫 540+ 合约 LLM 评分",应用 Many-Brains 提速。**核对后发现错**:

- `market/scanner.mjs:29-41` filter(volume>5M + |change|>2%)得到 ~数十 symbols
- `.slice(0, 10)` 再过滤,只对 top 10 做 RSI/BB 等**本地计算**(无 LLM)
- 最后 `candidates.slice(0, 3)` 才进 `researcher.researchCoin()`(走 LLM)
- **每 cycle 只有 3 个 LLM 调用,串行瓶颈微弱,Many-Brains 没意义**

把错误前提的方案留在 plan 里是给未来埋坑,撤回。

**修订后的真并行热点**

父 plan Phase 1.3(LLM signal pre-filter)才是真正会碰到并行需求的地方。当前 kline-monitor 同时订阅多个 symbol(BTC/ETH/SOL/...),如果它们**同时触发信号**(volume spike + MACD cross 常扎堆),父 plan 1.3 的串行 pre-filter 会让后到的信号排队 → 盘口抖动时延迟放大。

**做法**

父 plan 1.3 实现时**直接用 `Promise.allSettled` + `p-limit(concurrency=4)`**,而不是 for-of 串行。concurrency 限制是防 LLM provider rps 超限。

**接受标准**(并入父 plan 1.3 的接受标准)

- 多 symbol 同 cycle 触发信号时,pre-filter 总时延 ≤ `max(单次延时) × ceil(N/4)` 而非 `sum(单次延时)`
- metric `llm_prefilter_concurrent_peak`(同一刻的并发 pre-filter 数)

**估算**:**0 增量**(并入父 plan 1.3 的实现,多写 3-5 行 `p-limit` 即可)

**依赖**:父 plan 1.3(共用实现)

**笔记**:这次错误的根因是首稿凭记忆写"540+ 合约 → LLM 研究",没对源码。此后任何"并行化/批量化"类提议必须先 grep 实际 LLM call site 再写。

---

## 缺项 4:Brain prompt 上下文凭据扫描

**问题**

P0 已经修了 exec_shell + read_file 的路径黑名单(防 LLM 主动读 .env)。但还有一类被动泄露:

- 某个 webhook / TradingView MCP 返回的 JSON 里包含 secret(比如 alert URL 带 token)
- 某条 conversation_history 历史里包含用户粘贴的 API key 片段
- pipeline event log 后续上线后,某条 event 的 payload 里 echo 了 env var

这些都会被作为 brain 的 context 传给 LLM provider,**等于把 secret 上传到第三方**。

父 plan 没有这个防护层。

**做法**

1. 新建 `agent/security/sanitizer.mjs`,导出 `sanitizeForBrain(text) → text`
2. 检测规则(优先级从高到低):
   - **诸葛自有 secret**(最重要):
     - `BITGET_API_KEY/SECRET/PASS` 的**实际值**(启动时从 env 读进内存的 set,运行时反查匹配 → 最可靠,不依赖 regex 猜格式)
     - `TELEGRAM_BOT_TOKEN`、`LLM_KEY`、`OPENAI_API_KEY` 同理
     - `OTEL_EXPORTER_*` headers 里可能含 bearer
   - **通用 token 格式**(防用户粘贴第三方 secret):
     - `sk-[a-zA-Z0-9]{20,}`、`xoxb-`、`ghp_`、`AKIA`、`Bearer\s+[a-zA-Z0-9._\-]{20,}`
   - **entropy heuristic**:长度 >40 且 shannon entropy >4.5 的字符串(兜底)
3. 注入位置**多处**:
   - `agent/loop.mjs:62` 每次调 `chatStream` 之前 sweep 整个 message array
   - `agents/runner.mjs` 的 `runAgent()` 入口 sweep system prompt(analyst 的 `lessonsBlock` / `performanceBlock` 是拼 DB 内容,最可能混入脏数据)
   - `pipeline.mjs` 所有 `runAgent` 入参也走这一层
4. 命中后:替换为 `[REDACTED:type]`,emit event `brain_input_redacted` 带 source path(**不要 emit 原文**,否则 event log 自己成泄露源)
5. **白名单**:某些 tool result 必须保留特定格式(比如 Bitget `marginCoin: 'USDT'` 里的非敏感字段、EVM 公开地址),用 `_unsafe_keep` 标记

**接受标准**

- 单元测试:输入含 fake API key 的 message → 输出不包含原 key
- pipeline 跑完一轮 0 次 redaction(说明现有数据流干净);若有 redaction,emit event 告警并人工排查
- metric `brain_input_redactions_total` 始终为 0 是健康状态

**估算**:0.5d 实现 + 0.5d 测试 + 0.5d 接入 = **1.5 人日**

**依赖**:无;独立可做。建议在 capability gateway(缺项 2)之前做,因为 gateway 也会经过这层。

---

## 盲点清单(本 addendum 也没覆盖的)

1. **Event log retention** — 父 plan 3.4 提了 "pipeline_events: 90 天",但父 1.1 实现时要主动挂接 retention job,否则 SQLite 会撑爆。两者要在 1.1 落地时一起做,不能拖到 3.4。
2. **历史脏数据迁移清洗** — 父 plan 2.2 把 `conversation_history` 从 1h TTL 改成长期持久化。持久化后旧数据里**可能已有未 sanitize 的 secret**(之前没有缺项 4 的保护)。2.2 落地时需要跑一次性 migration,用缺项 4 的 sanitizer 扫描全表。
3. **Tool executor 返回值规范化** — 当前 `RISK_EXECUTORS`、`ANALYST_EXECUTORS` 有的返回 `JSON.stringify({error:...})`,有的抛 exception。缺项 2 的 capability gateway 假设统一接口,所以必须先做 "tool executor 返回 shape 统一"(都返回 `{ ok, data?, error? }` 字符串)。**0.5d,已并入缺项 2 估算**。
4. **Brain 降级 failover 明确不做** — capability gateway 让 brain 可换,但**运行时自动降级**(primary provider down → fallback provider)**暂不做**。理由:双 provider quota + 错发到不同 provider 的 inconsistency 成本 > 单 provider 宕机的概率收益。手动切就够。

---

## 总执行顺序(addendum + 父 plan 合并)

```
Week 1(本周):
  ✅ P0 exec_shell 加固(已做)
  → 缺项 4 凭据 sanitizer          1.5d  独立
  → 缺项 1 Risk 审计(T0 阶段)    1.5d  独立(审计+flag,T14 再看数据收尾)
  → Phase 1.1 Event Log            父 plan,无依赖,先做
                                   ⚠ 落地时一起做 retention(盲点 1)

Week 2:
  → Phase 1.2 Tool 分层            父 plan
  → Phase 1.3 LLM Pre-filter       父 plan,实现时直接用 p-limit(缺项 3 修订版)

Week 3:
  → 缺项 2 Capability gateway      4.5d(含 tool return 规范化)
  → Phase 2.1 无状态 Pipeline      父 plan
  → Phase 2.2 Session 持久化       父 plan
                                   ⚠ 落地时跑 sanitizer migration(盲点 2)
  → Phase 2.3a Vault               父 plan
  → 缺项 1 Risk 审计(T14 收尾)   0.5d(数据复盘 + 删除无效 B 类规则)

Week 4:
  → Phase 3.* 全部(父 plan)
```

总增量:**8 人日**(缺项 1+2+3+4 = 3+4.5+0+1.5 - 1d 首稿 overestimate 纠正)

修正:首稿写"8 人日(2+3+1.5+1.5)"。修订后 1 号升 1d、2 号升 1.5d、3 号降 1.5d,**净不变仍 8 人日**,纯巧合。实际 risk 更高的是缺项 2(格式转换陷阱多),应留 buffer。

---

## 与父 plan 的关系

- 本 addendum **不取代**父 plan 的任何 phase
- 缺项 2(capability gateway)对父 plan 的 Phase 1.2 / 3.1 提供更好的实现底座 —— 建议把 1.2 推迟到 gateway 之后做
- 缺项 1(Risk 审计)与 Phase 3.2(deterministic self-eval)互补:3.2 是新增机制,缺项 1 是清理旧机制
- 缺项 3(修订 K 线 pre-filter 并行)直接并入父 Phase 1.3 实现,无独立工时
- 缺项 4(凭据 sanitizer)与 Phase 2.3a(Vault)互补:2.3a 防主动读取,缺项 4 防被动泄露

---

## 决策记录(为了 nmem 抓取)

- **不做**真正的 multi-brain 集群(继续单进程 + p-limit 并发,理由同父 plan)
- **不做**自动化 risk 规则发现(全人工分类,样本量小不值得自动化)
- **不做**capability gateway 的 RPC 化(保持 in-process 函数调用,decoupling 在接口层而非进程层)
- **不做**sanitizer 的 ML/LLM-based 检测(正则 + entropy 足够,LLM 检测本身又会泄露)
