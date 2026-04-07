# TradeAgent 项目记忆

## 项目状态
- **全部 Roadmap 完成** (2026-04-07)
- ~15000 行代码, 80+ 文件, 63 tests, 21 SQLite 表
- VPS: YOUR_VPS_IP, pm2 rifi-vps, 24/7 运行

## 架构
7-agent 自主交易系统，三层自进化知识架构，AI 生成策略，确定性回测。
- Pipeline: AI驱动调度 → Analyst(9工具) → Risk(fail-closed) → Strategist → Executor(Kelly+4级建仓)
- Scanner: 540+ 合约 → Researcher 评分 → Momentum 交易
- Compound: LLM 复盘 → 生成规则+策略 → RAG 反馈闭环
- 回测: conditions.mjs 确定性评估 + simulator + 新策略自动回测
- 记忆: 操作型(context.md) + 长期(notes/) + Dream Worker(6h整理)
- 可观测: 19 metrics + JSON logs + OTel→Jaeger + TG Dashboard

## 关键决策
- 不用 LLM 做回测（慢/贵/不可复现）
- 策略 proposed→active 需存活1轮compound（防幻觉直接交易）
- TP/SL 回测用悲观顺序（先查不利方向）
- 记忆不用 embedding 召回（<50 notes 规模关键词够用）
- Dream Worker 单次最多删3/合并3/创建2（防LLM幻觉清空记忆）
- compound system prompt 必须和 parser 格式一致（"输出JSON对象"不是"输出数组"）

## 踩过的坑
- LanceDB update 用 `where` 不是 `filter`，`filter` 会更新全表
- pipeline 处理 `close` action 不能映射 strong_sell（会反向开空）
- _send() topic 参数是 key 字符串不是数值
- proposed 策略不能进入 strategist 评估（会绕过激活门槛）
- 同根K线平仓不允许新入场（look-ahead bias）

## 部署
- 代码: GitHub enderzcx/tradeagent (private)
- 部署: `bash /home/ubuntu/tradeagent/deploy.sh` = git pull + npm install + pm2 restart
- 绝不通过 MCP 传文件到 VPS，用 git push + deploy.sh

## Codex Review
每次代码改动必须 Codex review。流程: 写代码 → /codex:rescue review → 修复 findings → commit → push → deploy
