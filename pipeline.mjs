/**
 * Pipeline: collectAndAnalyze, runFullAnalysis, patrol reports, auto-trade trigger.
 * Extracted from vps-api-index.mjs lines ~1162-1424, ~2053-2072, ~2329-2355.
 */

import { startRootSpan, withSpan, endSpan } from './agent/observe/tracing.mjs';
import { context } from '@opentelemetry/api';

const PATROL_INTERVAL = 12; // 12 * 15min = 3h

export function createPipeline({ config, db, dataSources, analyst, riskAgent, bitgetExec, strategist, reviewer, priceStream, scanner, signals, telegram, agentRunner, cache, messageBus, llm, metrics, log: _extLog, pushEngine, prom }) {

  const { runAgent, agentMetrics } = agentRunner;
  const _metrics = metrics || { record() {} }; // fallback if not provided
  const _noop = () => {};
  const log = _extLog || { info: _noop, warn: _noop, error: _noop, debug: _noop };
  const { buildAnalystSystemPrompt, ANALYST_TOOLS, ANALYST_EXECUTORS } = analyst;
  const { runRiskCheck } = riskAgent;
  const { executeBitgetTrade, openScoutPosition, scaleUpPosition, abandonPosition,
          checkScaleUpConditions, checkAbandonConditions } = bitgetExec;
  const { runStrategistCheck } = strategist;
  const SCALING = config.SCALING;
  const { runReview, runWeeklyReview } = reviewer;
  const { scanMarketOpportunities } = scanner;
  const { scoreHistoricalSignals, updateSourceScores } = signals;
  const { fetchCrucix, fetchNews } = dataSources;
  const { sendTelegramAlert, checkAlerts } = telegram;
  const { persistNews, persistAnalysis, persistPatrol, insertDecision, insertAnalysis } = db;

  const bus = messageBus || { postMessage: () => {} };

  function buildPrompt(mode, crucixSummary, newsSummary, now) {
    if (mode === 'stock') {
      return `You are a senior US equity market intelligence analyst. Analyze the following real-time data and produce a structured JSON report focused on US stock market conditions.

Current time: ${now}

=== MACRO & MARKET DATA (Crucix 27-source intelligence) ===
${crucixSummary}

=== NEWS (AI-scored, signal: long/short/neutral) ===
${newsSummary}

Produce a JSON object with these exact fields:
{
  "macro_risk_score": <0-100, higher = more risk>,
  "stock_sentiment": <0-100, higher = more bullish on US equities>,
  "technical_bias": "long" | "short" | "neutral",
  "recommended_action": "strong_buy" | "increase_exposure" | "hold" | "reduce_exposure" | "strong_sell",
  "confidence": <0-100>,
  "alerts": [
    { "level": "FLASH|PRIORITY|ROUTINE", "signal": "<one-line Chinese description>", "source": "<data source>", "relevance": <0-100> }
  ],
  "briefing": "<3-4 sentence Chinese briefing for a US stock trader. Focus on S&P500, VIX, sector rotation, rate expectations, geopolitical impact on equities. Actionable, with reasoning. Include specific numbers.>",
  "push_worthy": <true if any alert deserves immediate user notification, false otherwise>,
  "push_reason": "<if push_worthy, one-line Chinese reason>"
}

Rules:
- alerts: max 6, sorted by relevance desc. FLASH = market-moving. PRIORITY = notable. ROUTINE = FYI.
- briefing: Chinese only, no English, no markdown. Include specific prices/numbers from data.
- Focus on equity-relevant signals: VIX changes, S&P500 moves, gold as safe-haven indicator, energy prices impact on sectors, geopolitical risk to markets.
- Filter out pure crypto news unless it has macro spillover implications (e.g. major regulatory action).
- push_worthy: true only for FLASH-level events (VIX spike >25, S&P500 drop >2%, major Fed action, geopolitical escalation)
- Be precise with numbers, don't round excessively

Output ONLY the JSON, no other text.`;
    }

    // Default: crypto mode (original prompt)
    return `You are a senior crypto trading intelligence analyst. Analyze the following real-time data and produce a structured JSON report.

Current time: ${now}

=== MACRO & MARKET DATA (Crucix 27-source intelligence) ===
${crucixSummary}

=== CRYPTO NEWS (AI-scored, signal: long/short/neutral) ===
${newsSummary}

Produce a JSON object with these exact fields:
{
  "macro_risk_score": <0-100, higher = more risk>,
  "crypto_sentiment": <0-100, higher = more bullish>,
  "technical_bias": "long" | "short" | "neutral",
  "recommended_action": "strong_buy" | "increase_exposure" | "hold" | "reduce_exposure" | "strong_sell",
  "confidence": <0-100>,
  "alerts": [
    { "level": "FLASH|PRIORITY|ROUTINE", "signal": "<one-line Chinese description>", "source": "<data source>", "relevance": <0-100> }
  ],
  "briefing": "<3-4 sentence Chinese briefing for a crypto trader. Actionable, with reasoning. Include specific numbers.>",
  "push_worthy": <true if any alert deserves immediate user notification, false otherwise>,
  "push_reason": "<if push_worthy, one-line Chinese reason>",
  "next_check_in": "<minutes until next analysis, e.g. '10' or '45' or '120'. YOU decide based on market conditions.>"
}

Rules:
- alerts: max 6, sorted by relevance desc. FLASH = market-moving. PRIORITY = notable. ROUTINE = FYI.
- briefing: Chinese only, no English, no markdown. Include specific prices/numbers from data.
- push_worthy: true only for FLASH-level events (VIX spike, major hack, regulation news, 5%+ price move)
- Be precise with numbers, don't round excessively
- next_check_in: YOU decide how soon to check again. Volatile market / FLASH event → 10-15min. Normal → 30-45min. Dead quiet → 60-120min. Max 240min (4h hard cap).

Output ONLY the JSON, no other text.`;
  }

  async function runFullAnalysis(mode, crucix, news, cycleId) {
    const c = cache[mode];
    if (c.analyzing) return;
    c.analyzing = true;

    const now = new Date().toISOString();
    const traceId = `analysis_${mode}_${Date.now()}`;

    try {
      // --- Analyst Agent ---
      const analystPrompt = buildAnalystSystemPrompt(mode);
      const _analystStart = Date.now();
      const analystResult = await runAgent('analyst', analystPrompt, ANALYST_TOOLS, ANALYST_EXECUTORS,
        `Analyze current ${mode} market conditions. Time: ${now}. Fetch data using your tools, then produce the JSON report.`,
        { trace_id: traceId, max_tokens: 1000, timeout: 90000 }
      );
      _metrics.record('llm_latency_ms', Date.now() - _analystStart, { agent: 'analyst', mode, cycleId });
      if (analystResult.tokensUsed) {
        _metrics.record('llm_tokens_in', analystResult.tokensUsed.input || 0, { agent: 'analyst' });
        _metrics.record('llm_tokens_out', analystResult.tokensUsed.output || 0, { agent: 'analyst' });
      }

      // Extract analysis from submit_analysis tool call (structured output, preferred)
      // Falls back to free-form text parsing if LLM didn't use the tool
      let parsed;
      const submitCall = analystResult.toolCalls.find(t => t.name === 'submit_analysis');
      if (submitCall) {
        const args = typeof submitCall.args === 'string' ? JSON.parse(submitCall.args) : submitCall.args;
        // Validate required fields
        if (args?.recommended_action && args?.confidence !== undefined && args?.briefing) {
          parsed = args;
        } else {
          log.warn('submit_analysis_incomplete', { module: 'pipeline', keys: Object.keys(args || {}) });
          // Fall through to text parsing
        }
      }
      if (!parsed) {
        // Fallback: legacy free-form text parsing
        try {
          const jsonStr = analystResult.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          parsed = JSON.parse(jsonStr);
          log.warn('analyst_legacy_text_output', { module: 'pipeline', mode });
        } catch {
          log.error('analyst_json_parse_failed', { module: 'pipeline', mode, raw: analystResult.content.slice(0, 500) });
          _metrics.record('error_count', 1, { module: 'pipeline', type: 'json_parse' });
          try { pushEngine?.pushError?.({ source: 'pipeline', message: `Analyst 输出解析失败 (${mode}): ${analystResult.content.slice(0, 150)}` }); } catch {}
          c.analyzing = false;
          return;
        }
      }

      c.analysis = {
        ...parsed,
        mode,
        timestamp: now,
        trace_id: traceId,
        cycle_id: cycleId,
        raw_sources: { crucix: analystResult.toolCalls.some(t => t.name === 'get_crucix_data'), news: analystResult.toolCalls.some(t => t.name === 'get_crypto_news') },
        agent: 'analyst',
      };
      c.lastUpdate = now;

      const sentimentKey = mode === 'stock' ? 'stock_sentiment' : 'crypto_sentiment';
      const sentimentVal = parsed[sentimentKey] || 0;
      log.info('analyst_result', { module: 'pipeline', mode, cycleId, risk: parsed.macro_risk_score, sentiment: sentimentVal, bias: parsed.technical_bias, action: parsed.recommended_action, push: parsed.push_worthy, tools: analystResult.toolCalls.length });
      if (prom?.setConfidence) prom.setConfidence(parsed.confidence || 0);

      // Persist to SQLite (atomic: analysis + decision in one transaction)
      const _decisionArgs = [now, 'analyst', 'analyze', '', '', JSON.stringify(parsed),
        `${mode} market analysis`, analystResult.content.slice(0, 500), '', parsed.confidence || 0, null];
      if (db.db?.transaction) {
        try {
          db.db.transaction(() => {
            // No try-catch inside — let errors propagate to trigger rollback
            insertAnalysis.run(mode, JSON.stringify(parsed), parsed.macro_risk_score || 0,
              parsed.crypto_sentiment || 0, parsed.stock_sentiment || 0,
              parsed.technical_bias || 'neutral', parsed.recommended_action || 'hold',
              parsed.confidence || 0, parsed.push_worthy ? 1 : 0, now);
            insertDecision.run(..._decisionArgs);
          })();
        } catch (e) { log.error('pipeline_txn_failed', { module: 'pipeline', error: e.message }); }
      } else {
        persistAnalysis(mode, parsed, now);
        try { insertDecision.run(..._decisionArgs); }
        catch (e) { log.warn('decision_insert_failed', { module: 'pipeline', error: e.message }); }
      }

      // Smart Push: if analyst says push_worthy, send to owner via TG
      if (parsed.push_worthy && pushEngine) {
        // Merge OpenNews + Crucix newsFeed for better URL coverage
        const openNewsItems = Array.isArray(news) ? news : [];
        const crucixFeed = Array.isArray(crucix?.newsFeed) ? crucix.newsFeed : [];
        const allNews = [...openNewsItems, ...crucixFeed]
          .filter(n => (n.title || n.headline) && (n.url || n.link))
          .slice(0, 5)
          .map(n => ({
            title: n.title || n.headline, url: n.url || n.link || '',
            score: n.score || 0, signal: n.signal || 'neutral',
            source: n.source || '',
          }));
        pushEngine.pushFlash({ analysis: parsed, news: allNews, traceId })
          .catch(err => log.error('push_flash_error', { module: 'pipeline', error: err.message }));
      }

      // Post analyst result to message bus
      bus.postMessage('analyst', 'risk', 'SIGNAL_UPDATE', parsed, traceId);

      // --- Risk Gate & Graduated Position Scaling ---
      if (mode === 'crypto') {
        if (SCALING?.enabled) {
          // If analyst specified a symbol, only run scaling for that one;
          // otherwise fall back to all configured symbols
          const targetSymbol = parsed.symbol ? parsed.symbol.toUpperCase() : null;
          const scalingSymbols = targetSymbol && SCALING.symbols.includes(targetSymbol)
            ? [targetSymbol]
            : SCALING.symbols;
          for (const symbol of scalingSymbols) {
            try {
              await _handleScalingForSymbol(symbol, parsed, traceId, now);
            } catch (err) {
              log.error('scaling_error', { module: 'scaling', symbol, error: err.message });
            }
          }
        } else {
          // Fallback: original all-or-nothing logic
          const shouldTrade = parsed.push_worthy ||
            (parsed.confidence >= 75 && ['strong_buy', 'strong_sell'].includes(parsed.recommended_action));
          if (shouldTrade) {
            const riskVerdict = await runRiskCheck(parsed, traceId);
            if (riskVerdict.pass) {
              executeBitgetTrade(parsed, traceId).catch(err => log.error('bitget_exec_error', { module: 'pipeline', error: err.message }));
              if (config.AUTO_TRADE_URL) {
                triggerAutoTrade({ ...parsed, trace_id: traceId, risk_verdict: riskVerdict })
                  .catch(err => log.error('auto_trade_trigger_failed', { module: 'pipeline', error: err.message }));
              }
            } else {
              log.warn('risk_veto', { module: 'pipeline', reason: riskVerdict.reason });
              try {
                insertDecision.run(now, 'risk', 'veto', '', '', JSON.stringify(riskVerdict),
                  'Auto-trade blocked by Risk agent', riskVerdict.reason, '', 0, null);
              } catch (e) { log.warn('decision_insert_failed', { module: 'pipeline', error: e.message }); }
            }
          }
        }
      }

      // --- Strategist Agent (crypto only, evaluate compound + manual strategies) ---
      if (mode === 'crypto') {
        try {
          const stratResult = await runStrategistCheck(parsed, traceId);
          // Handle strategy triggers: risk gate → executor with strategy-specific params
          if (stratResult?.triggered?.length > 0) {
            for (const trigger of stratResult.triggered) {
              if (trigger.action === 'hold' || !trigger.strategy_id) continue;

              // Only execute triggers from active strategies (not proposed)
              try {
                const stratRow = db.prepare('SELECT status FROM compound_strategies WHERE strategy_id = ?').get(trigger.strategy_id);
                if (!stratRow || stratRow.status !== 'active') {
                  log.info('strategy_trigger_skip_not_active', { module: 'pipeline', strategy: trigger.strategy_id, status: stratRow?.status });
                  continue;
                }
              } catch {}

              // Close action = close existing position, NOT open a new one
              if (trigger.action === 'close') {
                log.info('strategy_close_signal', { module: 'pipeline', strategy: trigger.strategy_id, symbol: trigger.symbol });
                // TODO: implement position close via executor (for now, log only)
                continue;
              }

              // Only open_long / open_short trigger new trades
              if (trigger.action !== 'open_long' && trigger.action !== 'open_short') continue;

              const isBuy = trigger.action === 'open_long';
              const tradeSignal = {
                ...parsed,
                recommended_action: isBuy ? 'strong_buy' : 'strong_sell',
                symbol: trigger.symbol,
                strategy_id: trigger.strategy_id,
                params: trigger.params || {},
                ...(trigger.params || {}), // flatten params for executor
              };
              const riskVerdict = await runRiskCheck(tradeSignal, traceId);
              if (riskVerdict.pass) {
                executeBitgetTrade(tradeSignal, traceId).catch(err => log.error('strategy_trade_error', { module: 'pipeline', strategy: trigger.strategy_id, error: err.message }));
              } else {
                log.warn('strategy_risk_veto', { module: 'pipeline', strategy: trigger.strategy_id, reason: riskVerdict.reason });
              }
            }
          }
        } catch (err) { log.error('strategist_error', { module: 'pipeline', error: err.message }); }
      }

      // Patrol report: accumulate and push every 3h (per mode)
      c.patrolHistory.push({ ...parsed, timestamp: now });
      c.patrolCounter++;
      if (c.patrolCounter >= PATROL_INTERVAL) {
        pushPatrolReport(mode, c.patrolHistory).catch(err => log.error('patrol_error', { module: 'patrol', mode, error: err.message }));
        // Run Reviewer alongside patrol (every 3h)
        if (mode === 'crypto') {
          runReview(traceId).catch(err => log.error('reviewer_error', { module: 'pipeline', error: err.message }));
          // Check if weekly review is due (self-healing: checks on every patrol cycle)
          runWeeklyReview(traceId).catch(err => log.error('weekly_review_error', { module: 'pipeline', error: err.message }));
        }
        c.patrolHistory = [];
        c.patrolCounter = 0;
      }
    } catch (err) {
      log.error('analysis_error', { module: 'pipeline', mode, cycleId, error: err.message });
      _metrics.record('error_count', 1, { module: 'pipeline', type: 'analysis', cycleId });
    }
    c.analyzing = false;

    // Return AI-decided next check interval (or default 30min)
    const nextMin = parseInt(parsed?.next_check_in) || 30;
    const clamped = Math.min(Math.max(nextMin, 5), 240); // 5min floor, 4h ceiling
    return clamped;
  }

  // --- Patrol Report (3h summary) ---

  async function generatePatrolReport(mode, history) {
    if (!history.length) return null;

    const sentimentKey = mode === 'stock' ? 'stock_sentiment' : 'crypto_sentiment';
    const roleLabel = mode === 'stock' ? '美股市场AI' : '加密交易AI';

    const summary = history.map((h) => {
      const t = new Date(h.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      return `${t} | Risk:${h.macro_risk_score} Sent:${h[sentimentKey] || 0} Bias:${h.technical_bias} Action:${h.recommended_action} Conf:${h.confidence}`;
    }).join('\n');

    const prompt = `你是${roleLabel}的巡逻报告员。以下是过去3小时每15分钟一次的市场分析记录（共${history.length}次）：

${summary}

最新一次的完整 briefing：${history[history.length - 1]?.briefing || 'N/A'}

请生成一份简洁的3小时巡逻报告（中文），包含：
1. 这3小时内市场整体走势（risk/sentiment 变化趋势）
2. 是否有值得注意的变化或异常
3. AI 做了什么操作（如果全是hold就说"未执行任何交易"）
4. 下一阶段关注点

要求：4-6句话，简洁直接，像给老板的快报。不要用markdown格式符号。`;

    try {
      const result = await llm([{ role: 'user', content: prompt }], { max_tokens: 400, timeout: 20000 });
      return result.content;
    } catch (err) {
      log.error('patrol_report_gen_failed', { module: 'patrol', mode, error: err.message });
      const latest = history[history.length - 1];
      return `过去3小时完成${history.length}次${mode === 'stock' ? '美股' : '加密'}市场扫描。最新状态：风险${latest.macro_risk_score}/100，情绪${latest[sentimentKey] || 0}/100，偏向${latest.technical_bias}，建议${latest.recommended_action}。未执行交易。`;
    }
  }

  async function pushPatrolReport(mode, history) {
    const report = await generatePatrolReport(mode, history);
    if (!report) return;

    const sentimentKey = mode === 'stock' ? 'stock_sentiment' : 'crypto_sentiment';
    const risks = history.map(h => h.macro_risk_score);
    const sents = history.map(h => h[sentimentKey] || 0);
    const actions = history.map(h => h.recommended_action);
    const trades = actions.filter(a => a === 'strong_buy' || a === 'strong_sell' || a === 'increase_exposure');

    const period = `${new Date(history[0].timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} - ${new Date(history[history.length - 1].timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
    const riskRange = `${Math.min(...risks)}-${Math.max(...risks)}`;
    const sentRange = `${Math.min(...sents)}-${Math.max(...sents)}`;

    // Persist to SQLite
    persistPatrol(mode, report, period, history.length, riskRange, sentRange, trades.length, new Date().toISOString());

    // Push via frontend SSE (crypto only -- stock has no auto-trade)
    if (config.AUTO_TRADE_URL && mode === 'crypto') {
      const payload = {
        type: 'PATROL_REPORT',
        level: 'LOW',
        data: {
          report, mode, period,
          scans: history.length,
          risk_range: riskRange,
          sentiment_range: sentRange,
          trades_executed: trades.length,
          dominant_action: mostCommon(actions),
        },
        timestamp: new Date().toISOString(),
      };

      const baseUrl = config.AUTO_TRADE_URL.replace('/api/auto-trade', '');
      try {
        await fetch(`${baseUrl}/api/patrol-report`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.AUTO_TRADE_SECRET}` },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000),
        });
        log.info('patrol_pushed', { module: 'patrol', mode, scans: history.length });
        _metrics.record('push_sent', 1, { level: 'PATROL' });
      } catch (err) {
        log.error('patrol_push_failed', { module: 'patrol', mode, error: err.message });
      }
    }
  }

  function mostCommon(arr) {
    const freq = {};
    for (const v of arr) freq[v] = (freq[v] || 0) + 1;
    return Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0] || 'hold';
  }

  async function triggerAutoTrade(signal) {
    const traceId = signal.trace_id || `trade_${Date.now()}`;
    const riskVerdict = signal.risk_verdict;
    log.info('executor_trigger', { module: 'pipeline', risk: riskVerdict?.pass ? 'PASS' : 'N/A', reason: signal.push_reason || 'high-value' });
    try {
      const res = await fetch(config.AUTO_TRADE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.AUTO_TRADE_SECRET}` },
        body: JSON.stringify({ signal, trace_id: traceId }),
        signal: AbortSignal.timeout(60000),
      });
      const data = await res.json();
      log.info('executor_response', { module: 'pipeline', status: data.status, tools: data.tool_calls || 0 });
      bus.postMessage('executor', 'reviewer', 'TRADE_RESULT', data, traceId);
    } catch (err) {
      log.error('executor_failed', { module: 'pipeline', error: err.message });
    }
  }

  async function collectAndAnalyze() {
    const cycleId = `cycle_${Date.now()}`;
    const { span: cycleSpan, ctx: cycleCtx } = startRootSpan('pipeline_cycle', { cycleId });
    log.info('collecting_data', { module: 'pipeline', cycleId });
    const _collectStart = Date.now();

    try {
      // --- Data collection wrapped in span ---
      const { crucix, news, marketScanCount } = await withSpan(cycleCtx, 'data_collect', { cycleId }, async () => {
        // Scanner: broad market scan for logging/monitoring (analyst uses its own tools for BTC/ETH/SOL)
        let _marketScanCount = 0;
        try {
          const opps = await scanMarketOpportunities();
          _marketScanCount = opps.length;
        } catch (e) { log.error('scanner_error', { module: 'pipeline', cycleId, error: e.message }); _metrics.record('error_count', 1, { module: 'pipeline', type: 'scanner', cycleId }); }

        const _fetchStart = Date.now();
        const [_crucix, _news] = await Promise.all([fetchCrucix(), fetchNews()]);
        const _newsCount = Array.isArray(_news) ? _news.length : 0;
        _metrics.record('data_collect_ms', Date.now() - _fetchStart, { news: _newsCount, cycleId });
        _metrics.record('collect_cycle_ms', Date.now() - _collectStart, { news: _newsCount, scan: _marketScanCount, cycleId });
        log.info('data_collected', { module: 'pipeline', cycleId, crucix: !!_crucix, news: _newsCount, marketScan: _marketScanCount });

        // Persist raw news
        if (_newsCount > 0) persistNews(_news);

        return { crucix: _crucix, news: _news, marketScanCount: _marketScanCount };
      });

      // Run crypto analysis (stock disabled to save tokens)
      const nextCheckMin = await withSpan(cycleCtx, 'analysis', { mode: 'crypto' }, async () => runFullAnalysis('crypto', crucix, news, cycleId));
      // await runFullAnalysis('stock', crucix, news, cycleId);

      // Score historical signals (non-blocking)
      try { scoreHistoricalSignals(); } catch (e) { log.error('signal_score_error', { module: 'pipeline', cycleId, error: e.message }); _metrics.record('error_count', 1, { module: 'pipeline', type: 'signal_score', cycleId }); }

      // Update source scores monthly
      try { updateSourceScores(); } catch (e) { log.error('source_score_error', { module: 'pipeline', cycleId, error: e.message }); _metrics.record('error_count', 1, { module: 'pipeline', type: 'source_score', cycleId }); }

      // Momentum: discover + research + trade new/trending coins
      await withSpan(cycleCtx, 'momentum', { cycleId }, async () => scanner.runMomentumPipeline(cycleId));

      endSpan(cycleSpan);
      log.info('cycle_next_check', { module: 'pipeline', cycleId, nextCheckMin: nextCheckMin || 30 });
      return nextCheckMin || 30;
    } catch (err) {
      endSpan(cycleSpan, err);
      return 30; // default on error
    }
  }

  // --- Graduated Scaling: per-symbol decision logic ---
  async function _handleScalingForSymbol(symbol, signal, traceId, now) {
    const action = signal.recommended_action;
    const confidence = signal.confidence || 0;

    // Get current price for this symbol
    const pair = symbol.replace('USDT', '-USDT');
    const candleRow = db.prepare('SELECT close FROM candles WHERE pair = ? ORDER BY ts_start DESC LIMIT 1').get(pair);
    const currentPrice = candleRow?.close || 0;

    if (!currentPrice) {
      log.warn('scaling_no_price', { module: 'scaling', symbol });
      return;
    }

    const activeGroup = db.getActiveGroup(symbol);

    if (activeGroup) {
      // --- Has active position group: check scale-up or abandon ---

      // Check abandon first (stop-loss or strong reversal)
      if (checkAbandonConditions(activeGroup, signal, currentPrice)) {
        log.warn('scaling_abandon', { module: 'scaling', symbol, level: activeGroup.current_level });
        await abandonPosition(activeGroup, traceId);
        return;
      }

      // Check scale-up
      if (checkScaleUpConditions(activeGroup, signal, currentPrice)) {
        const nextLevel = activeGroup.current_level + 1;
        // Risk check before scaling up
        const riskVerdict = await runRiskCheck(signal, traceId);
        if (riskVerdict.pass) {
          const result = await scaleUpPosition(activeGroup, signal, traceId);
          if (result) {
            log.info('scaling_up', { module: 'scaling', symbol, level: result.level, size: result.size, avgEntry: result.avgEntry });
          }
        } else {
          log.warn('scaling_veto', { module: 'scaling', symbol, level: nextLevel, reason: riskVerdict.reason });
        }
      }
    } else {
      // --- No active position: check if we should open a scout ---
      const isDirectional = SCALING.action_requirements[0].includes(action);
      const meetsConfidence = confidence >= SCALING.confidence_thresholds[0];

      if (isDirectional && meetsConfidence) {
        // Risk check before opening scout (relaxed rules for smallest position)
        const riskVerdict = await runRiskCheck(signal, traceId, { isScout: true });
        if (riskVerdict.pass) {
          const result = await openScoutPosition(symbol, signal, traceId);
          if (result) {
            log.info('scout_opened', { module: 'scaling', symbol, side: result.holdSide, size: result.size });
          }
        } else {
          log.warn('scout_veto', { module: 'scaling', symbol, reason: riskVerdict.reason });
          try {
            insertDecision.run(now, 'risk', 'scout_veto', '', '', JSON.stringify(riskVerdict),
              `Scout blocked for ${symbol}`, riskVerdict.reason, '', confidence, null);
          } catch (e) { log.warn('decision_insert_failed', { module: 'pipeline', error: e.message }); }
        }
      }
    }
  }

  return { collectAndAnalyze, runFullAnalysis, db: db.db, signals };
}
