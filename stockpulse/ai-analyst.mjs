/**
 * StockPulse AI Analyst — LLM-powered event analysis and push enrichment.
 *
 * Responsibilities:
 * - Enrich push events with multi-dimensional analysis (when template isn't enough)
 * - Generate daily briefs
 * - Handle user follow-up questions (追问)
 * - Provide historical analogies
 */

// Events that need LLM analysis (complex, multi-factor)
const LLM_EVENTS = new Set([
  'VIX_SPIKE', 'NEWS_SIGNAL', 'GEO_ALERT', 'MACRO_EVENT', 'SECTOR_MOVE',
]);

// Events where template is enough (simple price moves)
const TEMPLATE_EVENTS = new Set([
  'PRICE_SPIKE',
]);

export function createAIAnalyst({ llmQueue, db, config }) {

  // ── System prompt ──────────────────────────────────────────────────────

  const SYSTEM_PROMPT = `你是 StockPulse 首席情报官，为中文美股散户提供机构级情报简报。

你的风格参考华尔街见闻/财联社的盘前早报，但更简洁、更有态度。

核心原则：
1. 说人话。"VIX 24.54 偏高"没人看得懂，要说"恐慌指数飙到24，市场在怕什么？中东。"
2. 先给结论再给数据。不要列数字，要讲故事。
3. 每段开头用一个抓眼球的短句，像新闻标题一样。
4. 必须回答"所以呢？"——对散户意味着什么，今天该怎么应对。
5. 用中文，关键术语可用英文。不用 Markdown 格式符号。
6. 不给具体买卖建议，用"多看少动""轻仓观望""注意止损"等散户听得懂的话。
7. 引用具体数据时带上数字，但融入句子里，不要单独列。`;

  // ── Enrich event with LLM analysis ──────────────────────────────────────

  /**
   * Analyze an event with LLM and return enriched push message.
   * For PRICE_SPIKE < 5%, returns null (use template instead).
   */
  async function analyzeEvent(event, marketContext) {
    // Skip template-only events unless they're significant
    if (TEMPLATE_EVENTS.has(event.type)) {
      const absPct = Math.abs(event.data?.changePct || 0);
      if (absPct < 5) return null; // template is enough
    }

    if (!LLM_EVENTS.has(event.type) && !TEMPLATE_EVENTS.has(event.type)) return null;

    const userPrompt = buildEventPrompt(event, marketContext);

    try {
      const result = await llmQueue.enqueue(
        event.priority === 'P0' ? 2 : 4, // StockPulse P0 → queue priority 2, others → 4
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        { max_tokens: 300, temperature: 0.3, timeout: 20000 }
      );

      return result.content;
    } catch (e) {
      console.error('[StockPulse AI] Event analysis failed:', e.message);
      return null; // fallback to template
    }
  }

  function buildEventPrompt(event, ctx) {
    const parts = [`事件类型: ${event.type}`, `优先级: ${event.priority}`];

    if (event.symbol) parts.push(`标的: ${event.symbol}`);
    parts.push(`事件数据: ${JSON.stringify(event.data)}`);

    if (ctx) {
      const v = (x) => typeof x === 'object' && x !== null ? (x.price ?? x.value ?? JSON.stringify(x)) : x;
      if (ctx.vix) parts.push(`VIX: ${v(ctx.vix)}`);
      if (ctx.sp500) parts.push(`S&P500: $${v(ctx.sp500)}`);
      if (ctx.qqq) parts.push(`QQQ: $${v(ctx.qqq)}`);
      if (ctx.tlt) parts.push(`TLT(国债): $${v(ctx.tlt)}`);
      if (ctx.gold) parts.push(`黄金: $${v(ctx.gold)}`);
      if (ctx.wti) parts.push(`原油WTI: $${v(ctx.wti)}`);
      if (ctx.btc) parts.push(`BTC: $${v(ctx.btc)}`);
      if (ctx.conflicts) parts.push(`地缘冲突: ${ctx.conflicts.events}事件, ${ctx.conflicts.fatalities}伤亡`);
      if (ctx.fred) parts.push(`FRED宏观: ${JSON.stringify(ctx.fred).slice(0, 200)}`);
    }

    parts.push('');
    parts.push(`请用不超过150字分析这个事件。格式：
第一句：一句话说清楚发生了什么（像新闻标题）
第二句：这对持仓意味着什么（涨/跌/波动会怎样）
第三句：散户现在该怎么办（具体建议）
不要用编号，三句话连成一段自然的中文。`);

    return parts.join('\n');
  }

  // ── Batch analysis (P2 events, hourly consolidation) ────────────────────

  /**
   * Analyze multiple P2 events in one LLM call.
   * Returns array of enriched messages.
   */
  async function batchAnalyze(events, marketContext) {
    if (!events.length) return [];

    const eventSummaries = events.map((e, i) =>
      `${i + 1}. [${e.type}] ${e.symbol || 'GLOBAL'}: ${JSON.stringify(e.data).slice(0, 200)}`
    ).join('\n');

    const prompt = `过去1小时发生了这些事，帮我快速过一遍，每条一句话点评（不超过60字），说清楚"发生了什么+对盘面意味着什么"：

${eventSummaries}

当前背景：VIX ${marketContext?.vix || '?'}, SPY ${JSON.stringify(marketContext?.sp500 || '?')}

格式：每条开头用序号，一句话搞定，像老手在群里快速刷消息的感觉。`;

    try {
      const result = await llmQueue.enqueue(4, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ], { max_tokens: 500, temperature: 0.3, timeout: 30000 });

      // Parse numbered responses
      const lines = result.content.split('\n').filter(l => /^\d+\./.test(l.trim()));
      return lines.map(l => l.replace(/^\d+\.\s*/, '').trim());
    } catch (e) {
      console.error('[StockPulse AI] Batch analysis failed:', e.message);
      return [];
    }
  }

  // ── Follow-up conversation (追问) ──────────────────────────────────────

  /**
   * Handle user follow-up question after receiving a push.
   * @param {string} question - User's question
   * @param {object} pushContext - The original push event
   * @param {object} marketContext - Current market data
   * @returns {string} AI response
   */
  async function followUp(question, pushContext, marketContext) {
    const contextPrompt = pushContext
      ? `用户收到了以下推送：\n${JSON.stringify(pushContext)}\n\n当前市场：${JSON.stringify(marketContext || {})}\n\n`
      : `当前市场：${JSON.stringify(marketContext || {})}\n\n`;

    try {
      const result = await llmQueue.enqueue(
        3,
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `${contextPrompt}用户问：${question}

像朋友私聊一样回答，不超过200字。直接给结论，不要"首先、其次"那套。如果不确定就说不确定，不要编。` },
        ],
        { max_tokens: 400, temperature: 0.4, timeout: 15000 }
      );
      return result.content;
    } catch (e) {
      console.error('[StockPulse AI] Follow-up failed:', e.message);
      return '分析暂时不可用，请稍后再试。';
    }
  }

  // ── Daily brief ────────────────────────────────────────────────────────

  /**
   * Generate morning brief for a user's watchlist.
   */
  async function dailyBrief(watchlist, marketContext) {
    const symbols = watchlist.map(w => w.symbol).join(', ');

    try {
      const result = await llmQueue.enqueue(4, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `写一份个性化盘前快报，用户关注这些票：${symbols}

实时数据：
${JSON.stringify(marketContext, null, 1)}

要求：
- 总共不超过400字
- 第一段"今日主线"：一句话点出今天最大的主题（地缘？通胀？财报？）
- 第二段"你的票"：逐个点评用户关注的票，每只1-2句，说清楚今天要注意什么。如果某只票今天没什么特别的就说"暂时安全"。
- 第三段"事件提醒"：今天有什么重要数据发布或事件（如果有的话）
- 最后一句话给个整体建议
- 不要用编号或bullet point，自然段落，有温度
- 融入具体数字` },
      ], { max_tokens: 600, temperature: 0.4, timeout: 25000 });

      return result.content;
    } catch (e) {
      console.error('[StockPulse AI] Daily brief failed:', e.message);
      return briefFallback(watchlist, marketContext);
    }
  }

  function briefFallback(watchlist, ctx) {
    const lines = ['市场快报（AI分析暂不可用，以下为实时数据）', ''];
    if (ctx?.vix) lines.push(`VIX: ${ctx.vix}`);
    if (ctx?.sp500) lines.push(`S&P500: ${JSON.stringify(ctx.sp500)}`);
    if (ctx?.wti) lines.push(`原油WTI: $${ctx.wti}`);
    if (ctx?.gold) lines.push(`黄金: ${JSON.stringify(ctx.gold)}`);
    if (ctx?.btc) lines.push(`BTC: $${ctx.btc}`);
    lines.push('');
    lines.push(`你的关注: ${watchlist.map(w => w.symbol).join(', ')}`);
    lines.push('');
    lines.push('⚠️ 仅供参考，不构成投资建议');
    return lines.join('\n');
  }

  // ── Macro analysis ─────────────────────────────────────────────────────

  async function macroAnalysis(marketContext) {
    try {
      const result = await llmQueue.enqueue(4, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `写一份美股盘前宏观情报简报。

实时数据：
${JSON.stringify(marketContext, null, 1)}

要求：
- 总共不超过350字
- 分3-4个段落，每段一个主题
- 每段用一个短标题开头（6字以内，不用emoji），后面换行写内容
- 第一段写"今天一句话"：一句话概括今天的盘前主线逻辑
- 中间段落写最重要的2-3个看点，融入具体数字（价格、涨跌幅），解释"为什么"和"意味着什么"
- 最后一段写"散户怎么办"：用大白话给出今天的应对思路
- 不要用编号列表，不要用bullet point，写成自然段落
- 语气要有温度，像一个老手在群里给新手解盘` },
      ], { max_tokens: 600, temperature: 0.4, timeout: 25000 });

      return result.content;
    } catch (e) {
      console.error('[StockPulse AI] Macro analysis failed:', e.message);
      return macroFallback(marketContext);
    }
  }

  function macroFallback(ctx) {
    if (!ctx) return '宏观数据暂时不可用。';
    const lines = ['宏观环境快照（AI分析暂不可用，以下为实时数据）', ''];
    if (ctx.vix) lines.push(`VIX: ${ctx.vix}${ctx.vix > 30 ? ' ⚠️ 高波动' : ctx.vix > 20 ? ' 偏高' : ' 平稳'}`);
    if (ctx.sp500) lines.push(`S&P500: ${JSON.stringify(ctx.sp500)}`);
    if (ctx.qqq) lines.push(`QQQ: ${JSON.stringify(ctx.qqq)}`);
    if (ctx.tlt) lines.push(`国债TLT: ${JSON.stringify(ctx.tlt)}`);
    if (ctx.gold) lines.push(`黄金: ${JSON.stringify(ctx.gold)}`);
    if (ctx.wti) lines.push(`原油WTI: $${ctx.wti}`);
    if (ctx.brent) lines.push(`布伦特: $${ctx.brent}`);
    if (ctx.btc) lines.push(`BTC: $${ctx.btc}`);
    if (ctx.conflicts) lines.push(`冲突: ${ctx.conflicts.events} 事件, ${ctx.conflicts.fatalities} 伤亡`);
    if (lines.length <= 2) lines.push('暂无数据');
    lines.push('');
    lines.push('⚠️ 仅供参考，不构成投资建议');
    return lines.join('\n');
  }

  // ── Detail analysis for single ticker ──────────────────────────────────

  async function detailAnalysis(symbol, quoteData, marketContext) {
    try {
      const result = await llmQueue.enqueue(3, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `给我讲讲 ${symbol} 现在什么情况。

行情: ${JSON.stringify(quoteData)}
大盘: VIX=${marketContext?.vix || '?'}, SPY=${JSON.stringify(marketContext?.sp500 || '?')}

要求（不超过250字）：
- 开头一句话定调：这票今天是安全的还是需要小心的？
- 然后说为什么：走势、关键价位、最近有什么催化剂或雷
- 最后一句话给建议：继续拿着/可以加/该跑了/先观望
- 写成自然段落，不要编号列表` },
      ], { max_tokens: 400, temperature: 0.4, timeout: 20000 });

      return result.content;
    } catch (e) {
      console.error('[StockPulse AI] Detail analysis failed:', e.message);
      if (quoteData && !quoteData.error) {
        const dir = quoteData.changePct > 0 ? '+' : '';
        return `${symbol} (${quoteData.name || symbol})\n\n价格: $${quoteData.price}\n日涨跌: ${dir}${quoteData.changePct}%\n交易所: ${quoteData.exchange}\n状态: ${quoteData.marketState}\n\n(AI深度分析暂不可用)`;

      }
      return `${symbol} 分析暂时不可用，请稍后重试。`;
    }
  }

  // ── Risk analysis (地缘+宏观风险) ──────────────────────────────────────

  async function riskAnalysis(marketContext, newsDigest) {
    try {
      const result = await llmQueue.enqueue(3, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `你是地缘风险分析师。根据以下实时数据，给散户写一份风险评估报告。

实时市场数据：
${JSON.stringify(marketContext, null, 1)}

最新新闻标题：
${newsDigest || '暂无'}

要求（不超过400字）：
- 第一段"风险评级"：一句话给出当前风险等级（低/中/高/极高），加上核心原因
- 第二段"正在发生什么"：结合新闻说清楚当前最大的地缘/宏观风险是什么，具体到事件（不要说"请关注"，要说"目前的情况是..."）
- 第三段"对你的钱包意味着什么"：哪些板块/资产会受冲击，避险资产（黄金、美债）现在什么状态，资金在往哪跑
- 第四段"怎么应对"：一句话大白话建议
- 融入具体数字（VIX、金价、油价等），不要空谈
- 不要用编号列表，自然段落` },
      ], { max_tokens: 600, temperature: 0.4, timeout: 25000 });

      return result.content;
    } catch (e) {
      console.error('[StockPulse AI] Risk analysis failed:', e.message);
      // fallback
      const vix = marketContext?.vix;
      const gold = marketContext?.gold;
      if (vix || gold) {
        return `风险快照（AI分析暂不可用）\n\nVIX: ${vix || '?'}\n黄金: $${gold || '?'}\n\n请稍后重试获取完整分析。`;
      }
      return '风险分析暂时不可用，请稍后再试。';
    }
  }

  return {
    analyzeEvent,
    batchAnalyze,
    followUp,
    dailyBrief,
    macroAnalysis,
    detailAnalysis,
    riskAnalysis,
  };
}
