<div align="center">

# 诸葛 Zhuge

**自托管的 7-Agent 自主 AI 交易系统**

*观其大略，运筹帷幄，决胜千里*

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![SQLite](https://img.shields.io/badge/SQLite-21_tables-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![Bitget](https://img.shields.io/badge/Bitget-USDT_Futures-00D084)](https://www.bitget.com/)
[![Tests](https://img.shields.io/badge/tests-63_passing-brightgreen)]()
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

[English](README.md) [简体中文]

</div>

---

诸葛是一个 **7-Agent 自主交易系统**，7x24 运行在单台 VPS 上。扫描 540+ 加密货币合约市场，通过多 Agent 流水线做出交易决策，使用 Kelly 公式仓位管理在 Bitget 执行交易，并持续进化自身的交易知识 —— 全程无需人工干预。

不是聊天机器人套壳。不是回测框架。是一台用真金白银交易的、能自我进化的交易机器。

## 为什么叫诸葛？

市面上大多数"AI 交易机器人"要么是：
- 一个 LLM 调用输出买/卖（没有风控，不会学习）
- 一个规则系统贴了个"AI"标签（没有真正的智能）
- 一个永远不碰真钱的模拟盘 demo

**诸葛不一样：**

| | 普通交易机器人 | 诸葛 |
|---|---|---|
| 决策 | 单次 LLM 调用 | 7 个 Agent 各司其职 |
| 风控 | 固定止损 | Fail-closed 风控门 + Kelly 仓位 + 4级金字塔建仓 |
| 学习 | 不会 | 三层知识架构：专家 RAG + 自主发现规则 + 实时情报 |
| 执行 | REST 轮询 | WebSocket 事件驱动（成交 <1s 入库） |
| 策略 | 写死的 | AI 生成 → 自动回测 → 生命周期管理 |
| 记忆 | 无状态 | Dream Worker 每 6h 自主整理记忆 |
| 回测 | LLM 参与（慢、不可复现） | 确定性条件评估器（快、可复现） |

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                  流水线（AI 自适应调度）                        │
│                                                              │
│   Crucix 27源       OKX WebSocket      OpenNews AI 评分      │
│     OSINT              实时价格             新闻              │
│       │                  │                  │                │
│       └──────────┬───────┘──────────────────┘                │
│                  ▼                                            │
│       ┌─────────────────────┐                                │
│       │   分析师 Agent       │  9 个工具，AI 自主选择调用       │
│       │  submit_analysis()  │  结构化输出（函数调用，非文本）   │
│       └────────┬────────────┘                                │
│                ▼                                              │
│       ┌─────────────────────┐                                │
│       │   风控 Agent         │  硬规则（代码级）               │
│       │  submit_verdict()   │  + LLM 软评估                  │
│       │  权益来自 WS 缓存    │  Fail-closed：默认 VETO        │
│       └────────┬────────────┘                                │
│                ▼                                              │
│       ┌─────────────────────┐                                │
│       │   执行器             │  Kelly 公式（半 Kelly）         │
│       │  4级金字塔建仓       │  1:1:2:4 比例                  │
│       │  WS 事件驱动         │  成交 → <1s 入库               │
│       └─────────────────────┘                                │
│                                                              │
│   扫描器 ─── 540+ 合约 ─── 研究员 Agent ─── 动量交易          │
│                                                              │
│   复盘系统 ── 复盘交易 ── 生成规则 ── 进化                     │
│   Dream Worker ── 每 6h 合并/清理/提炼记忆                     │
│   审计员 Agent ── 信号准确度 ── 经验提取                       │
│   策略师 Agent ── 评估 AI 生成的策略                           │
└─────────────────────────────────────────────────────────────┘
```

## 三层知识架构

让诸葛真正能"学习"而不只是"执行"：

```
第一层：专家知识（RAG）
│  48+ 条目：Wyckoff、SMC、ICT、Kelly、Fib 0.31、OI 背离...
│  本地 Ollama 向量化 + LanceDB 向量检索
│  零 API 成本，110ms 检索
│
第二层：自主发现的知识（Compound 复盘）
│  LLM 复盘交易历史 + 否决模式 + 信号准确度
│  → 自动生成规则（带置信度 + 证据）
│  → 规则直接控制执行参数（杠杆、止盈止损、保证金）
│  → 新策略生命周期：proposed → 回测 → active → retired
│
第三层：实时情报
│  Crucix 27源 OSINT + OKX 价格 + TG 快讯 + AI 新闻
│
└─ 反馈闭环：
   第一层 → 影响交易 → 结果喂给第二层
   → 第二层验证第一层知识有效性 → 进化
```

## 事件驱动执行

不轮询。没有 `setTimeout` hack。通过 Bitget 私有 WebSocket 实时推送：

```
订单成交   → WS orders 频道   → 成交价即时入库 → DB 更新
仓位平仓   → WS positions 频道 → PnL 计算 → 触发审计员
余额变动   → WS account 频道   → 权益缓存 → 风控 Agent 直接读缓存

REST 同步每 30min 作为兜底（WS 不健康时降为 5min）。
自适应：系统知道什么时候信任 WS，什么时候回退到 REST。
```

## 风控体系

诸葛的风控设计原则是"宁可错杀，不可放过"：

- **Fail-closed 风控门：** 状态未知 → VETO。权益获取失败 → VETO。解析错误 → VETO
- **24h 亏损限制：** 已实现 + 未实现亏损 > 权益的 5% → 全部暂停交易
- **连续亏损冷却：** 3+ 笔亏损（金字塔模式下 5 笔）→ 强制冷却 1 小时
- **Kelly 公式仓位管理：** 半 Kelly，上限 25% 可用保证金
- **4级金字塔建仓：** 先小仓试探，只在信心递增 + 价格确认后加仓
- **策略门槛：** AI 生成的策略不能直接交易，必须存活一轮复盘周期
- **回测门槛：** 新策略自动回测 14 天，胜率 <20% 直接 retired

## 技术栈

| 组件 | 选型 | 理由 |
|------|------|------|
| 运行时 | Node.js (ESM) | 单线程事件循环天然适合交易流水线 |
| 数据库 | SQLite (WAL 模式) | 21 张表，零运维，单文件备份 |
| 向量库 | LanceDB + Ollama | 本地向量化，零 API 成本，110ms 检索 |
| LLM | OpenAI 兼容 API | 每个 Agent 独立选模型，自动降级链 |
| 交易所 | Bitget（私有 WebSocket） | 事件驱动成交推送，540+ 合约对 |
| 数据 | Crucix (27 源) + OpenNews | 宏观 + 新闻 + 链上一个调用搞定 |
| 链路追踪 | OpenTelemetry → Jaeger | 3 层 span 模型，全链路可观测 |
| 交互 | Telegram Bot | 流式回复、确认键盘、超级群组仪表板 |
| 测试 | Vitest | 63 个用例：指标、Kelly 数学、建仓、信号、记忆 |

## 快速开始

```bash
git clone https://github.com/enderzcx/Zhuge.git
cd Zhuge
cp .env.example .env
# 填入：Bitget API 密钥、LLM 端点、Telegram bot token（可选）
npm install
node index.mjs
```

### 依赖

- Node.js 20+
- Ollama 运行 `nomic-embed-text` 模型（用于 RAG 知识检索）
- Bitget API 密钥（需要 USDT-FUTURES 权限）
- OpenAI 兼容的 LLM 端点（已测试 gpt-4o-mini, gpt-5.4-mini）
- （可选）Telegram bot token，用于仪表板 + 自然语言指令

## 项目结构

```
├── index.mjs              — 入口，模块装配
├── pipeline.mjs           — 采集 → 分析 → 交易 主循环
├── config.mjs / db.mjs    — 配置 + 21 张表 SQLite schema
│
├── agent/                 — 诸葛 TG Agent 框架
│   ├── cognition/         — 复盘系统、Dream Worker、条件评估器
│   ├── knowledge/         — 交易 RAG（LanceDB + Ollama）
│   ├── memory/            — 带 frontmatter 元数据的索引化召回
│   ├── tools/             — 20+ 工具（数据、系统、交易、记忆）
│   ├── push/              — 智能推送引擎 + TG 仪表板
│   └── observe/           — 指标、日志、健康监控、OTel 追踪
│
├── agents/                — 6 个自主子 Agent
│   ├── analyst.mjs        — 9 工具 + submit_analysis（结构化输出）
│   ├── risk.mjs           — Fail-closed 风控 + submit_verdict
│   ├── researcher.mjs     — 币种动量评分（4 维度）
│   ├── strategist.mjs     — AI 策略评估
│   ├── reviewer.mjs       — 经验提取 + 信号准确度
│   └── runner.mjs         — 通用 Agent 循环 + 工具调用
│
├── bitget/                — 交易所集成
│   ├── ws.mjs             — 私有 WebSocket（订单/仓位/账户）
│   ├── client.mjs         — REST API + 签名 + 限流退避
│   └── executor.mjs       — Kelly 仓位、4级建仓、WS 事件处理
│
├── market/                — 市场数据
│   ├── prices.mjs         — OKX WebSocket + 异常检测
│   ├── scanner.mjs        — 540+ 合约扫描器
│   └── indicators.mjs     — RSI、EMA、MACD、ATR、布林、Fib（纯数学）
│
├── backtest/              — 确定性回测引擎
│   ├── engine.mjs         — K线回放 + 条件评估
│   └── simulator.mjs      — 仓位管理 + PnL 计算
│
└── tests/                 — 63 个单元测试 (vitest)
```

## 设计决策

一些不显而易见的技术选择和原因：

- **回测不用 LLM。** LLM 输出不确定 → 回测结果不可复现。诸葛用纯 `conditions.mjs` 评估器，快且一致。
- **结构化输出用函数调用。** 不让 LLM 输出 JSON 文本（约 5% 概率解析失败），而是让 Agent 调用 `submit_analysis()` / `submit_verdict()` 工具，schema 由函数定义强制约束。
- **Dream Worker 有限额。** 每轮最多删 3 条 + 合并 3 条 + 新建 2 条。没有这个限制，LLM 幻觉可能一轮清空全部记忆。
- **策略生命周期。** `proposed → 回测 → active → retired`。AI 生成的策略不能直接用真钱交易，必须过回测 + 存活一轮复盘。防止 LLM 幻觉直接下单。
- **WebSocket 优先，REST 兜底。** 事件驱动消除了轮询间隔内仓位平仓无法检测的盲区。REST 自适应：WS 健康时 30min，不健康时 5min。
- **悲观回测。** 做多时先检查最低价（止损），再检查最高价（止盈）。防止系统性的乐观偏差。

## 许可证

AGPL-3.0。详见 [LICENSE](LICENSE)。

---

<div align="center">

Built by [0xEnder](https://x.com/0xenderzcx) — AI Native Builder

*代码在跑，Agent 在交易。*

</div>
