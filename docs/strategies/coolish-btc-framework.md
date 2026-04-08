# Wei1.0 到 TradeAgent 的策略规格

更新时间: 2026-04-08
状态: design-approved spec
适用范围: `compound_strategies` / `compound_rules` / `conditions.mjs` / `backtest`

## 概述

策略族名称: `Wei`
版本名称: `Wei1.0`

这不是对 `coolish` 交易行为的“像素级复刻”。

这是把他公开表达过、并被其 BitMEX 实盘流水部分验证过的交易框架，翻译成当前 `TradeAgent` 能表达、能回测、能逐步落地的一套规格。

核心判断:

- `coolish` 的本质不是“高频交易系统”，而是“BTC 单市场深理解 + 线性仓位管理 + 少数高赔率窗口重仓”的持续在场框架。
- 这个框架不是单一 entry/exit 信号，而是一个上层组合:
  - 市场选择层: 高度聚焦 BTC
  - 方向层: 先判大环境，再决定偏多/偏空/减仓
  - 仓位层: 仓位是连续变量，不是 0/100 二元开关
  - 时间层: 不只看价格，也看走势持续多久、预期应在多长时间内兑现
  - 风控层: 不是固定止损止盈，而是持续重算“此刻该持有多少”

因此，推荐在 `TradeAgent` 中把它实现为:

1. 一组 BTC-only 的 compound strategies
2. 一组负责调参数的 compound rules
3. 后续再补齐更贴近原始理论的引擎扩展

## 直接目标

把 `coolish` 理论落成一个可以进入现有生命周期的最小版本:

- `proposed -> backtest -> active -> retired`
- 可由 `strategist.mjs` 评估
- 可由 `backtest/engine.mjs` 确定性回测
- 不要求第一版就完全复刻其“持续在场 + 梯子挂单 + 目标净敞口”风格

## 不做什么

第一阶段明确不做:

- 不做“完全跟单式复刻”
- 不做 BitMEX 币本位净敞口模拟
- 不做真实限价梯子成交仿真
- 不做多 tranche 独立保质期仓位
- 不做 X 舆情全文情绪因子直连
- 不做“always-in-market”强制常驻仓位

原因不是这些不重要，而是当前引擎还没有对应的表达能力。

## 理论拆解

### 1. 市场聚焦

他长期演化后的执行对象高度收敛到 BTC。

对 `TradeAgent` 的翻译:

- 第一版只做 `BTCUSDT`
- 不把这套理论直接泛化到 alt momentum 池
- 若后续要迁移到 ETH，视为新策略族，不和 BTC 共用同一组参数

### 2. 时间大于价格

他的核心不是“涨跌了多少”，而是:

- 当前走势速度能否持续
- 这个速度最迟在哪个时间 deadline 前失效
- 当前位置是否已经进入“时间不再支持原方向延续”的阶段

对 `TradeAgent` 的翻译:

- 第一版用以下代理变量近似:
  - `bb_width`
  - `adx`, `adx_trending`
  - `market_structure_trend`
  - `bos_type`
  - `trend`
- 第二版需要新增显式时间类指标:
  - `days_in_regime`
  - `bars_since_breakout`
  - `bars_since_breakdown`
  - `days_above_ema15`
  - `volatility_percentile_30d`

### 3. 线性仓位而不是二元开关

他的仓位思想是:

- 不是“开还是不开”
- 而是“0% 到 100% 之间，今天应该拿多少”
- 不是固定止损止盈
- 而是持续把当前仓位向“现在理性上应该拿的仓位”靠拢

对 `TradeAgent` 的翻译:

- 第一版不能直接做目标仓位引擎
- 先拆成:
  - 小仓试探策略
  - 高置信加码策略
  - 防守性对冲/减仓策略
- 也就是把一个连续仓位曲线，离散成几个确定性状态

### 4. 普攻 vs 放技能

他的描述里，绝大多数动作属于“普攻”，真正赚钱的是少数“放技能”窗口。

对 `TradeAgent` 的翻译:

- 普攻 = 小保证金、低杠杆、宽容错的 BTC regime strategy
- 放技能 = 只在趋势确认 + 结构确认 + 波动释放时启用的 size-up strategy
- 引擎层约束:
  - 默认 leverage 不高
  - 默认 margin 不大
  - 只有高置信策略才允许显著加杠杆/加保证金

### 5. 套牢盘 / 历史价格区间 / ATH 区间

他的原始框架非常重视历史价格区间、套牢盘压力、远期阻力。

当前系统里没有直接的“套牢盘压力”字段。

第一版代理实现:

- `support_20`, `resistance_20`
- `market_structure_trend`
- `fibonacci_*`
- `bb_position`

第二版新增字段:

- `distance_to_ath_pct`
- `range_percentile_180d`
- `overhead_supply_score_90d`
- `overhead_supply_score_365d`
- `distance_to_major_prior_range_high`

### 6. 时间止损

他的原始思路不是只有价格止损，还有“保质期”止损。

当前系统状态:

- schema 里有 `max_hold_minutes`
- 但 `backtest/engine.mjs` 目前没有执行时间止损逻辑

结论:

- 第一阶段文档里保留 `max_hold_minutes`
- 但明确标记为“需要引擎支持后才完全生效”
- 在没补引擎前，不能宣称已经实现了 `coolish` 的时间维度核心

## 推荐实现路径

推荐走“两层实现”。

### 层 1: 当前引擎可落地的最小版本

这层只使用现有 `conditions.mjs` 能评估的字段。

#### 策略 A: `wei1_probe_long`

用途:

- 充当“普攻型”试探仓
- 只在 BTC 已进入偏强环境时建立轻仓多头
- 不追求吃满主升段，只追求长期留在正确方向一侧

建议定义:

- direction: `long`
- symbols: `["BTCUSDT"]`
- timeframe: `any`
- entry_conditions:
  - `trend eq bullish`
  - `market_structure_trend eq bullish`
  - `rsi_14 between 45 ~ 68`
  - `adx_trending eq true`
- exit_conditions:
  - `trend eq bearish`
  - `bos_type eq bearish`
  - `rsi_14 gt 74`
- sizing:
  - `margin_usdt: 1.5`
  - `leverage: 2`
- risk_params:
  - `sl_pct: 0.02`
  - `tp_pct: 0.05`
  - `max_hold_minutes: 2880`

设计理由:

- 这是“常备小仓在场感”的代理实现
- 用小仓替代真实的连续净敞口
- 用趋势和结构共振过滤掉大量逆风试错

#### 策略 B: `wei1_skill_add_long`

用途:

- 充当“放技能”的加码多头
- 只在趋势确认且动能释放阶段出手

建议定义:

- direction: `long`
- symbols: `["BTCUSDT"]`
- timeframe: `any`
- entry_conditions:
  - `trend eq bullish`
  - `bos_type eq bullish`
  - `bb_position gt 0.8`
  - `rsi_14 between 55 ~ 72`
- exit_conditions:
  - `rsi_14 gt 78`
  - `trend eq bearish`
  - `price lt ma_20`
- sizing:
  - `margin_usdt: 3`
  - `leverage: 4`
- risk_params:
  - `sl_pct: 0.018`
  - `tp_pct: 0.07`
  - `max_hold_minutes: 1440`

设计理由:

- 用更严格 entry 去模拟“只有强烈信号才重一点”
- size 明显高于 probe，但仍保持保守，不直接极限杠杆

#### 策略 C: `wei1_defensive_short`

用途:

- 充当防守性空头/对冲层
- 不是极端看空系统，而是趋势恶化时站到防守侧

建议定义:

- direction: `short`
- symbols: `["BTCUSDT"]`
- timeframe: `any`
- entry_conditions:
  - `trend eq bearish`
  - `market_structure_trend eq bearish`
  - `adx_trending eq true`
  - `rsi_14 between 32 ~ 55`
- exit_conditions:
  - `bos_type eq bullish`
  - `price gt ma_20`
  - `rsi_14 lt 25`
- sizing:
  - `margin_usdt: 2`
  - `leverage: 3`
- risk_params:
  - `sl_pct: 0.02`
  - `tp_pct: 0.06`
  - `max_hold_minutes: 2160`

设计理由:

- 对应他近几年更明显的“高位压力区谨慎、不恋战、防守性平衡净敞口”
- 不是逆势顶底摸空
- 只在结构和趋势都偏空时激活

### 层 2: compound rules 参数层

`coolish` 的很多 edge 不是靠某一个开平仓点，而是靠“什么时候应该更轻、更重、更保守”。

因此第二层应该是 parameter override rules，而不只是 strategies。

建议初始规则:

#### 规则 1: 波动压缩期降杠杆

- rule_id: `wei1_reduce_leverage_in_compression`
- 条件解释:
  - `bb_width` 很窄
  - `adx` 不强
  - 说明市场还在积累，不值得重拳
- 参数建议:
  - `leverage -> 2`
  - `margin_per_trade -> 1.5`

#### 规则 2: 结构确认后允许放大

- rule_id: `wei1_size_up_after_structure_break`
- 条件解释:
  - `bos_type` 明确
  - `market_structure_trend` 和 `trend` 同向
- 参数建议:
  - `leverage -> 4~5`
  - `margin_per_trade -> 3`

#### 规则 3: 高位过热时降低盈利预期

- rule_id: `wei1_reduce_tp_in_overheat`
- 条件解释:
  - `rsi_14` 过高
  - `bb_position` 贴近上沿
  - 对应他“不指望短期一蹴而就强延续”的思想
- 参数建议:
  - `tp_pct -> 0.03 ~ 0.04`
  - `sl_pct` 不放太宽

#### 规则 4: 方向不明时降低交易频率

- rule_id: `wei1_wait_when_mixed_structure`

## 策略族与版本管理

这套东西应该被视为一个策略族，而不是单条策略。

建议命名约定:

- 策略族: `Wei`
- 首个版本: `Wei1.0`
- 子策略:
  - `wei1_probe_long`
  - `wei1_skill_add_long`
  - `wei1_defensive_short`
- 规则:
  - `wei1_*`

后续版本建议:

- `Wei1.1`
- `Wei1.2`
- `Wei2.0`

每个版本都应保留原版内容，不应覆盖旧版本。

### 当前系统现状

诸葛现在有“当前策略选择”能力，但还没有“策略家族管理”能力。

已具备的部分:

- `strategist.mjs` 会在 active 策略里评估 match score
- 多个策略冲突时会优先选最高 confidence 的那个
- `scanner.mjs` 会根据 symbol 和 direction 找匹配的 active strategy
- `compound_rules` 能统一调整参数

缺少的部分:

- 没有“策略族”概念
- 没有“版本”概念
- 没有“主策略/副策略/停用版本”的显式切换器
- 没有跨策略家族的绩效比较和自动轮换
- 没有 immutable snapshot 机制

### 为什么现在不能复用同一个 strategy_id 迭代

当前 `compound.mjs` 对 `compound_strategies` 的写入方式是:

- `ON CONFLICT(strategy_id) DO UPDATE`

这意味着:

- 如果 `wei1_probe_long` 后面继续被同 id 更新
- 原始的 `Wei1.0` 内容会被覆盖

所以如果要保留原版，必须满足至少一个条件:

1. 采用版本化的全新 strategy_id
2. 或者扩表增加 family/version/parent_strategy_id，并把旧版本冻结

### 现阶段推荐做法

如果先不改数据库 schema，推荐最小规则是:

- `Wei1.0` 一旦落地，其 strategy_id 永远不复用
- 小改版新建:
  - `wei1_1_probe_long`
  - `wei1_1_skill_add_long`
  - `wei1_1_defensive_short`
- 大改版新建:
  - `wei2_probe_long`
  - `wei2_skill_add_long`
  - `wei2_defensive_short`
- 旧版通过 `status=retired` 或保持 inactive，不删除

这样能在不改 schema 的情况下，先做到“原版保留”。

### 更合理的下一步

在多策略体系逐渐变多之后，应该补一个真正的“策略选择层”。

推荐新增一个上层对象，例如:

- `strategy_families`

建议字段:

- `family_id`
- `family_name`
- `version`
- `base_thesis`
- `status`
- `parent_version`
- `promoted_from`
- `notes`

并新增一个“策略分配/切换”模块，负责:

- 哪个 family 当前是主用
- 哪些 family 只观察不交易
- 哪些版本正在 shadow backtest
- 哪些版本替代了旧版本

在这个模块存在之前，诸葛更像是“会从 active 策略中挑可触发者”，还不是“会在多套策略体系间做组合管理和版本优化”。
- 条件解释:
  - `trend` 与 `market_structure_trend` 冲突
  - 或 `bos_type = none`
- 参数建议:
  - `min_score -> 提高`
  - `max_open -> 1`

## 为什么不推荐“一条大一统策略”

不推荐把它压成一条全能策略，原因有四个:

- `coolish` 的原始框架本来就是组合型，不是单 trigger
- 当前回测引擎一次只支持一个仓位，组合行为本来就已经被压缩
- 一条大策略会把“试探”和“重拳”混成一团，失去可解释性
- compound 生命周期更适合淘汰某一条子策略，而不是整套理论一起死

## 当前系统与原始理论的差距

以下差距必须明确承认。

### 差距 1: 当前引擎是离散仓位，不是目标净敞口

原始理论:

- 核心是“此刻应该持有多少”

当前系统:

- 核心还是“开仓 / 平仓 / 固定 margin / 固定 leverage”

影响:

- 第一版只能做近似，不是原版

### 差距 2: 当前回测是信号触发，不是梯子挂单成交

原始理论:

- 大量委托单不为全成交而存在
- 挂单距离和大小跟波动率绑定

当前系统:

- 满足条件即按 candle close 模拟成交

影响:

- 会失真他的“守株待兔式限价单”优势

### 差距 3: 没有时间止损执行

原始理论:

- 下注有 1 天 / 3 天 / 7 天不同保质期

当前系统:

- `max_hold_minutes` 还未真正执行

影响:

- 会损失“时间大于价格”的重要部分

### 差距 4: 没有历史套牢盘评分

原始理论:

- 非常重视远期价格区间和套牢压力

当前系统:

- 只有短窗 support/resistance 和部分结构指标

影响:

- 高位去风险逻辑会偏弱

## 第二阶段需要的引擎扩展

如果要更接近原始理论，建议按下面顺序扩展。

### 扩展 1: 时间类指标与时间止损

需要新增:

- `days_in_regime`
- `bars_since_breakout`
- `bars_since_breakdown`
- `days_above_ema15`
- `max_hold_minutes` 真正执行

优先级: 高

原因:

- 这是“时间大于价格”的最小技术底座

### 扩展 2: 历史压力 / 套牢盘代理字段

需要新增:

- `distance_to_ath_pct`
- `range_percentile_180d`
- `overhead_supply_score_90d`
- `overhead_supply_score_365d`
- `distance_to_prior_major_range_high`

优先级: 高

原因:

- 这是他做“别指望一蹴而就”的重要依据

### 扩展 3: 目标仓位模式

需要新增:

- `target_exposure_pct`
- position adjust API
- 回测支持“加 / 减 / 对冲”而不是只 open/close

优先级: 中高

原因:

- 这是最接近其原始思想的核心抽象

### 扩展 4: 限价梯子回测

需要新增:

- ladder order schema
- volatility-aware order distance
- partial fill simulation

优先级: 中

原因:

- 能更真实地还原其执行 edge
- 但工作量大于前两项

## 数据流建议

```text
market candles
  -> indicators.mjs 扩充时间/压力类字段
  -> conditions.mjs 评估 strategy conditions
  -> strategist.mjs 选择 BTC-only coolish 子策略
  -> compound_rules 覆盖 leverage / margin / tp / sl / min_score
  -> executor 执行
  -> backtest/engine.mjs 用同一字段回放
```

## 测试要求

落地时至少覆盖:

1. `conditions.mjs` 支持本策略族需要的布尔/字符串字段比较
2. `backtest/engine.mjs` 正确执行时间止损
3. 新增历史压力字段后，指标快照在窗口边界不报错
4. BTC-only 策略在样本不足时不会误触发
5. same-candle close 后不允许立即反手，继续保持当前 guardrail

## 交付顺序

推荐分三步落地。

### Step 1

只新增三条 BTC-only compound strategies，不改引擎。

目标:

- 先观察当前指标表达下，这套理论的最小版本是否有基本生命力

### Step 2

补时间止损和时间类指标。

目标:

- 把“时间大于价格”从口号变成系统能力

### Step 3

补历史压力字段与目标仓位模式。

目标:

- 从“像 coolish 的三条策略”升级为“更像 coolish 的组合框架”

## 最终结论

推荐方案不是“复刻 coolish”，而是“先把 coolish 理论拆成当前系统能承受的三层”:

1. BTC-only 子策略族
2. 参数覆盖规则层
3. 后续引擎扩展

这是当前仓库里最简单、最可回测、也最不容易做成伪实现的路径。

一句话总结:

`先实现 coolish 的骨架，不假装已经实现 coolish 的全部血肉。`
