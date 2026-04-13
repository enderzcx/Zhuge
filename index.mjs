/**
 * VPS entry point: wire all modules and start the server.
 */

import express from 'express';
import { createConfig } from './config.mjs';
import { createDB } from './db.mjs';
import { createLLM } from './llm.mjs';
import { createBitgetClient } from './bitget/client.mjs';
import { createBitgetWS } from './bitget/ws.mjs';
import { createBitgetExecutor } from './bitget/executor.mjs';
import { registerBitgetRoutes } from './bitget/routes.mjs';
import { createMessageBus } from './agents/message-bus.mjs';
import { createAgentRunner } from './agents/runner.mjs';
import { createAnalyst } from './agents/analyst.mjs';
import { createRiskAgent } from './agents/risk.mjs';
import { createMandateGate } from './agents/mandate-gate.mjs';
import { createMandateGate as createKernelMandateGate } from './kernel/mandate/gate.mjs';
import { loadTraderMandate, buildMandateContext } from './harness/trader/mandate.mjs';
import { createStrategist } from './agents/strategist.mjs';
import { createReviewer } from './agents/reviewer.mjs';
import { createResearcher } from './agents/researcher.mjs';
import { createPriceStream } from './market/prices.mjs';
import { createSignalScoring } from './market/signals.mjs';
import { createScanner } from './market/scanner.mjs';
import { createKlineMonitor } from './market/kline-monitor.mjs';
import * as indicators from './market/indicators.mjs';
import { createDataSources } from './integrations/data-sources.mjs';
import { createIntelStream } from './integrations/intel.mjs';
import { createLiFi, registerLiFiRoutes } from './integrations/lifi.mjs';
import { createTelegram } from './integrations/telegram.mjs';
import { createPipeline } from './pipeline.mjs';
// Observability
import { createMetrics } from './agent/observe/metrics.mjs';
import { createPrometheus } from './agent/observe/prometheus.mjs';
import { createLogger } from './agent/observe/logger.mjs';
import { createHealthMonitor } from './agent/observe/health.mjs';
import { initTracing, shutdownTracing } from './agent/observe/tracing.mjs';
// Agent Harness — TG Agent
import { createAgentLLM } from './agent/llm.mjs';
import { createHistory } from './agent/history.mjs';
import { createModelSelector } from './agent/model-select.mjs';
import { createToolRegistry } from './agent/tools/registry.mjs';
import { createToolExecutor } from './agent/tools/executor.mjs';
import { createSystemTools } from './agent/tools/system.mjs';
import { createDataTools } from './agent/tools/data.mjs';
import { createRAG } from './agent/knowledge/rag.mjs';
import { createTradeTools } from './agent/tools/trade.mjs';
import { createMemoryTools } from './agent/tools/memory.mjs';
import { createScheduleTools } from './agent/tools/schedule.mjs';
import { createTradingViewTools } from './agent/tools/tradingview.mjs';
import { createTaskScheduler } from './agent/scheduler.mjs';
import { createPromptLoader } from './agent/prompts/loader.mjs';
import { createConfirmHandler } from './agent/telegram/confirm.mjs';
import { createAgentBot } from './agent/telegram/bot.mjs';
import { createProvenance } from './agent/cognition/provenance.mjs';
import { createCompound } from './agent/cognition/compound.mjs';
import { createDream } from './agent/cognition/dream.mjs';
import { createStrategySelector } from './agent/cognition/strategy-selector.mjs';
// Push Engine (Phase 3) + Dashboard (Phase 4) + Primary Market (Phase 5)
import { createPushEngine as createSmartPush } from './agent/push/engine.mjs';
import { createDashboard } from './agent/push/dashboard.mjs';
import { createPrimaryMarket } from './market/primary.mjs';
// Route registrars
import { registerAnalysisRoutes } from './routes/analysis.mjs';
import { registerTradeRoutes } from './routes/trades.mjs';
import { registerDecisionRoutes } from './routes/decisions.mjs';
import { registerHistoryRoutes } from './routes/history.mjs';
import { registerStrategyRoutes } from './routes/strategies.mjs';
import { registerLearningRoutes } from './routes/learning.mjs';
import { registerMarketRoutes } from './routes/market.mjs';

const config = createConfig();
const app = express();
app.use(express.json());

// --- Create modules ---
initTracing('zhuge', process.env.OTEL_ENDPOINT);
const { log, readLogs } = createLogger();
const db = createDB({ log });
const strategySelector = createStrategySelector({ db: db.db, log });
strategySelector.bootstrapWei1();
strategySelector.bootstrapWei2();
const metrics = createMetrics(db.db);
const prom = createPrometheus(metrics);
// alertFn wired after pushEngine creation below
const _alertRef = { fn: null };
const health = createHealthMonitor(metrics, { log, alertFn: (msg) => _alertRef.fn?.(msg) });
health.start();
const llm = createLLM(config);
const bitgetClient = createBitgetClient(config, { metrics, log });
const bitgetWS = createBitgetWS(config, { log, metrics });
const messageBus = createMessageBus({ db });
const agentRunner = createAgentRunner({ config, db, messageBus, metrics, log });
const dataSources = createDataSources(config);
const intelStream = createIntelStream({ config, db, metrics });
dataSources.setIntelStream(intelStream);
const priceStream = createPriceStream({ db, config, log, metrics });
const signals = createSignalScoring({ db });
const lifi = createLiFi(config);
const _ragRef = { instance: null };
const _researcherRef = { instance: null };
const analyst = createAnalyst({ db, config, bitgetClient, dataSources, priceStream, indicators, rag: { search: (...a) => _ragRef.instance?.search(...a) || [] }, metrics, researcher: { researchCoin: (...a) => _researcherRef.instance?.researchCoin(...a) } });
const mandateGate = createMandateGate({ db, config, bitgetClient, bitgetWS, messageBus, log });
// Kernel mandate gate (shadow mode — runs alongside old gate for validation)
const kernelMandateGate = createKernelMandateGate();
loadTraderMandate(kernelMandateGate);
const riskAgent = createRiskAgent({ db, config, agentRunner, messageBus, log });
const cache = {
  crypto: { analysis: null, lastUpdate: null, analyzing: false, patrolHistory: [], patrolCounter: 0 },
  stock:  { analysis: null, lastUpdate: null, analyzing: false, patrolHistory: [], patrolCounter: 0 },
};
const strategist = createStrategist({
  db,
  agentRunner,
  messageBus,
  cache,
  log,
  compound: { getParamOverrides: () => _compoundRef.instance?.getParamOverrides() || {}, getActiveStrategies: () => _compoundRef.instance?.getActiveStrategies() || [] },
  bitgetClient,
  indicators,
  strategySelector,
});
const telegram = createTelegram({ db, config, agentMetrics: agentRunner.agentMetrics, cache });
const reviewer = createReviewer({ db, config, agentRunner, messageBus, telegram, log });
// reviewer created first so checkAndSyncTrades can trigger lesson generation after trade close
const bitgetExec = createBitgetExecutor({ db, config, bitgetClient, bitgetWS, messageBus, reviewer, log, metrics });
const researcher = createResearcher({ db, config, bitgetClient, agentRunner, indicators, dataSources, log });
_researcherRef.instance = researcher;
const _compoundRef = { instance: null };
const scanner = createScanner({
  db,
  config,
  bitgetClient,
  agentRunner,
  indicators,
  tradingLock: bitgetExec.tradingLock,
  researcher,
  compound: { getParamOverrides: () => _compoundRef.instance?.getParamOverrides() || {} },
  log,
  metrics,
  strategySelector,
});
// Push engine created after agentBot (needs tgSend)
let pushEngine = null; // initialized after bot creation

// --- Agent Harness (Phase 2) ---
const agentLLM = createAgentLLM(config, { log, metrics });
const agentHistory = createHistory({ llm, db });
const restoredConvs = agentHistory.restore();
if (restoredConvs > 0) log.info('history_restored', { module: 'index', conversations: restoredConvs });
const modelSelector = createModelSelector(config);
const toolRegistry = createToolRegistry();
const agentProvenance = createProvenance({ db: db.db, log });
const agentCompound = createCompound({ db: db.db, llm, provenance: agentProvenance, log, metrics, rag: { getAll: (...a) => _ragRef.instance?.getAll(...a) || [], updateConfidence: (...a) => _ragRef.instance?.updateConfidence(...a) } });
_compoundRef.instance = agentCompound; // wire into scanner via getter

// --- Dream Worker (memory consolidation) ---
const _dashboardRef = { instance: null };
const dream = createDream({ db: db.db, llm, log, metrics, onComplete: (r) => _dashboardRef.instance?.postDream?.(r) });

dream.start();

// --- RAG Knowledge Base ---
const rag = createRAG({ config, log });
await rag.init();
await rag.seed('data/seed-knowledge.json').catch(e => log.warn('rag_seed_failed', { module: 'index', error: e.message }));
_ragRef.instance = rag; // wire into analyst via getter

// Register tools
const systemTools = createSystemTools({ log });
// pushEngine is null here, will be set after bot creation. Use getter pattern.
const _pushRef = { engine: null };
const _klineRef = { instance: null };
const dataTools = createDataTools({
  dataSources, priceStream, db: db.db, scanner,
  pushEngine: { getRecentContext: (...a) => _pushRef.engine?.getRecentContext(...a) || [] },
  compound: agentCompound, readLogs, rag,
  intelStream, config,
  klineMonitor: { subscribe: (...a) => _klineRef.instance?.subscribe(...a), unsubscribe: (...a) => _klineRef.instance?.unsubscribe(...a), getStatus: () => _klineRef.instance?.getStatus?.() || [], getIndicators: (...a) => _klineRef.instance?.getIndicators(...a) },
});
const tradeTools = createTradeTools({ bitgetClient, bitgetExec, db, config, mandateGate });
const memoryTools = createMemoryTools({ log, db });
// Scheduler created after scanner/pipeline (uses getter pattern for late-binding)
const _schedulerRef = { instance: null };
const scheduleTools = createScheduleTools({ db, log, scheduler: { refresh: () => _schedulerRef.instance?.refresh() } });
const tvTools = createTradingViewTools();
toolRegistry.registerAll([...systemTools.TOOL_DEFS, ...dataTools.TOOL_DEFS, ...tradeTools.TOOL_DEFS, ...memoryTools.TOOL_DEFS, ...scheduleTools.TOOL_DEFS, ...tvTools.TOOL_DEFS]);

const toolExecutor = createToolExecutor({ registry: toolRegistry, log, metrics });
toolExecutor.registerExecutors({ ...systemTools.EXECUTORS, ...dataTools.EXECUTORS, ...tradeTools.EXECUTORS, ...memoryTools.EXECUTORS, ...scheduleTools.EXECUTORS, ...tvTools.EXECUTORS });

const promptLoader = createPromptLoader({
  db: db.db,
  pushEngine: { getRecentContext: (...a) => _pushRef.engine?.getRecentContext(...a) || [] },
  dataSources,
  klineMonitor: { getStatus: () => _klineRef.instance?.getStatus?.() || [] },
});
const confirmHandler = createConfirmHandler({ tgCall: null, executor: toolExecutor, history: agentHistory, log }); // tgCall set after bot creation
const agentBot = createAgentBot({
  config, agentLLM, history: agentHistory, executor: toolExecutor,
  modelSelector, buildSystemPrompt: promptLoader.buildSystemPrompt,
  confirmHandler, log, metrics,
});
// Wire tgCall into confirmHandler (circular dep resolved via setTgCall)
confirmHandler.setTgCall(agentBot.tgCall);

// --- Push Engine (Phase 3) ---
const tgSend = (text) => agentBot.sendMessage(config.TG_CHAT_ID, text);
pushEngine = createSmartPush({ db, config, tgSend, tgCall: agentBot.tgCall, log, metrics });
_pushRef.engine = pushEngine; // wire into dataTools + promptLoader via getter
_alertRef.fn = (msg) => pushEngine.pushError({ source: 'health', message: msg }); // wire health alerts → TG

// Create pipeline (after push engine)
const pipeline = createPipeline({ config, db, dataSources, analyst, riskAgent, mandateGate, bitgetExec, strategist, reviewer, priceStream, scanner, signals, telegram, agentRunner, cache, messageBus, llm, metrics, log, pushEngine, prom, kernelMandateGate, bitgetClient, bitgetWS });

// Task Scheduler (agent-managed recurring jobs)
const taskScheduler = createTaskScheduler({ db, pipeline, scanner, compound: agentCompound, log, metrics, pushEngine });
_schedulerRef.instance = taskScheduler;
taskScheduler.start();

// --- Register routes ---
registerAnalysisRoutes(app, { cache, agentMetrics: agentRunner.agentMetrics, priceStream, config, pipeline, db, signals });
registerTradeRoutes(app, { db });
registerDecisionRoutes(app, { db });
registerHistoryRoutes(app, { db });
registerStrategyRoutes(app, { db, strategySelector, config });
registerLearningRoutes(app, { db, signals });
registerMarketRoutes(app, { db, priceStream });
registerBitgetRoutes(app, { bitgetClient, log });
registerLiFiRoutes(app, lifi);

// --- Prometheus metrics endpoint ---
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', prom.contentType);
  res.end(await prom.metricsText());
});

// --- K-line Monitor (real-time 5m/15m/1h indicator computation + signal detection) ---
const klineMonitor = createKlineMonitor({ db, priceStream, pipeline, messageBus, config, log, metrics, pushEngine: { pushError: (...a) => _pushRef.engine?.pushError?.(...a) } });
_klineRef.instance = klineMonitor;
priceStream.setOnCandleClose((pair, candle) => klineMonitor.onCandleClose(pair, candle));
klineMonitor.start();

// --- Anomaly handler (price spike -> instant analysis) ---
priceStream.setAnomalyHandler((anomaly) => {
  pipeline.collectAndAnalyze()
    .catch(err => log.error('anomaly_analysis_error', { module: 'index', error: err.message }))
    .finally(() => scanner.reviewPendingOrders().catch(e => log.error('pending_review_error', { module: 'index', error: e.message })));
});

// --- Start ---
app.listen(config.PORT, '127.0.0.1', () => {
  log.info('server_started', { module: 'index', port: config.PORT, host: '127.0.0.1', model: config.LLM_MODEL, interval: '30min' });
  // AI-driven scheduling: analyst decides next_check_in after each analysis
  async function runAnalysisLoop() {
    try {
      const nextMin = await pipeline.collectAndAnalyze();
      const nextMs = (nextMin || 30) * 60 * 1000;
      log.info('next_analysis_scheduled', { module: 'index', nextMin: nextMin || 30, reason: 'ai_decided' });
      setTimeout(runAnalysisLoop, nextMs);
    } catch (err) {
      log.error('analysis_loop_error', { module: 'index', error: err.message });
      setTimeout(runAnalysisLoop, 30 * 60 * 1000); // fallback 30min on error
    }
    scanner.reviewPendingOrders().catch(e => log.error('pending_review_error', { module: 'index', error: e.message }));
  }
  runAnalysisLoop();
  // Bitget Private WebSocket: register callbacks BEFORE connect to avoid missing early events
  bitgetWS.onOrderFill((fill) => bitgetExec.handleOrderFill?.(fill));
  bitgetWS.onPositionClose((pos) => bitgetExec.handlePositionClose?.(pos));

  // --- Floating loss monitor: react to drawdown in real-time ---
  let _lastDrawdownAlert = 0;
  bitgetWS.onPositionUpdate((positions) => {
    if (!bitgetWS.isHealthy()) return;
    const equity = bitgetWS.getEquity();
    if (equity <= 0) return;
    const totalPnL = bitgetWS.getUnrealizedPnL();
    const lossPct = -totalPnL / equity; // positive when losing

    // 5% threshold: FLASH alert (risk agent already blocks new trades at this level)
    if (lossPct >= 0.05 && Date.now() - _lastDrawdownAlert > 5 * 60 * 1000) {
      _lastDrawdownAlert = Date.now();
      log.error('drawdown_critical', { module: 'index', totalPnL: totalPnL.toFixed(2), equity: equity.toFixed(2), lossPct: (lossPct * 100).toFixed(1) });
      pushEngine?.pushError?.({ source: 'risk_monitor', message: `浮亏 ${totalPnL.toFixed(2)} USDT (${(lossPct * 100).toFixed(1)}% 权益)，已触发紧急分析` });
      pipeline.collectAndAnalyze().catch(e => log.error('emergency_analysis_error', { module: 'index', error: e.message }));
    }
    // 3% threshold: trigger instant analysis cycle
    else if (lossPct >= 0.03 && Date.now() - _lastDrawdownAlert > 5 * 60 * 1000) {
      _lastDrawdownAlert = Date.now();
      log.warn('drawdown_warning', { module: 'index', totalPnL: totalPnL.toFixed(2), equity: equity.toFixed(2), lossPct: (lossPct * 100).toFixed(1) });
      pipeline.collectAndAnalyze().catch(e => log.error('drawdown_analysis_error', { module: 'index', error: e.message }));
    }
  });

  bitgetWS.connect();

  // --- Intel Stream: TG channels + Twitter/X + free APIs (replaces old news flash polling) ---
  intelStream.setTriggerHandler((item) => {
    // Overlap guard: skip if last analysis was < 10 min ago or currently analyzing
    const lastAnalysis = cache.crypto.lastUpdate ? new Date(cache.crypto.lastUpdate).getTime() : 0;
    if (Date.now() - lastAnalysis < 10 * 60 * 1000) return;
    if (cache.crypto.analyzing) return;
    log.info('intel_flash_trigger', { module: 'intel', title: (item.title || '').slice(0, 80), score: item.score, source: item.source });
    pipeline.collectAndAnalyze().catch(e => log.error('intel_trigger_error', { module: 'intel', error: e.message }));
  });
  if (config.INTEL?.enabled) {
    intelStream.start().catch(e => log.error('intel_start_error', { module: 'intel', error: e.message }));
  } else {
    // Fallback: start API pollers only (no TG/X, but still better than nothing)
    intelStream.start().catch(e => log.error('intel_start_error', { module: 'intel', error: e.message }));
    log.warn('intel_degraded_mode', { module: 'intel', reason: 'TG_API_ID not set, running API pollers only' });
  }

  // Adaptive REST fallback sync: 5min when WS unhealthy, 30min when healthy
  function scheduleTradeSync() {
    const interval = bitgetWS.isHealthy() ? 30 * 60 * 1000 : 5 * 60 * 1000;
    setTimeout(() => {
      bitgetExec.checkAndSyncTrades().catch(e => log.error('trade_sync_error', { module: 'index', error: e.message }));
      scanner.reviewPendingOrders().catch(e => log.error('pending_review_error', { module: 'index', error: e.message }));
      scheduleTradeSync();
    }, interval);
  }
  scheduleTradeSync();
  // OKX WebSocket removed — price ticks now come from Bitget public WS via kline-monitor

  // Start TG bot
  if (config.TG_BOT_TOKEN) {
    agentBot.startPolling();
    log.info('agent_bot_started', { module: 'index' });
    // Dashboard: scheduled TG posts (positions, observe, charts)
    const dashboard = createDashboard({ config, db: db.db, tgCall: agentBot.tgCall, health, metrics, log, dataSources, llm });
    _dashboardRef.instance = dashboard;
    dashboard.start();
    // Primary Market: Base V3 pool listener (Phase 5)
    const primaryMarket = createPrimaryMarket({ config, pushEngine, tgCall: agentBot.tgCall, log, metrics });
    primaryMarket.start();
    // Check compound on startup, post result to dashboard
    if (agentCompound.shouldRun()) {
      agentCompound.run()
        .then(result => result && dashboard.postCompound(result))
        .catch(e => log.error('compound_startup_error', { module: 'index', error: e.message }));
    }
  }

  // --- Graceful shutdown ---
  async function shutdown(signal) {
    log.info('shutdown_start', { module: 'index', signal });
    try {
      // Stop accepting new work
      if (agentBot?.stop) agentBot.stop();
      intelStream.stop();
      taskScheduler.stop();
      health.stop();
      dream.stop();
      // Sync trades one last time (detect fills before exit)
      await bitgetExec.checkAndSyncTrades().catch(() => {});
      // Auto-save context.md — dump structured state so next startup has continuity
      try {
        const openTrades = db.prepare("SELECT pair, side, leverage, entry_price FROM trades WHERE status = 'open'").all();
        const recentDecisions = db.prepare("SELECT agent, action, output_summary, timestamp FROM decisions ORDER BY timestamp DESC LIMIT 3").all();
        const lines = [
          `# Auto-saved context (${new Date().toISOString()})`,
          '',
          `## Open Positions (${openTrades.length})`,
          openTrades.length > 0 ? openTrades.map(t => `- ${t.pair} ${t.side} ${t.leverage}x @ ${t.entry_price}`).join('\n') : '- None',
          '',
          '## Recent Decisions',
          recentDecisions.map(d => `- [${d.agent}] ${d.action}: ${(d.output_summary || '').slice(0, 100)}`).join('\n'),
          '',
          `Shutdown reason: ${signal}`,
        ];
        const { writeFileSync, renameSync } = await import('fs');
        const ctxPath = 'agent/memory/context.md';
        writeFileSync(ctxPath + '.tmp', lines.join('\n'), 'utf-8');
        renameSync(ctxPath + '.tmp', ctxPath);
      } catch (e) { log.warn('context_save_failed', { module: 'index', error: e.message }); }

      log.info('shutdown_done', { module: 'index', signal });
      // Flush OTel traces before closing
      await shutdownTracing().catch(() => {});
      // Close DB (flushes WAL) — must be after final log write
      if (db.db?.close) db.db.close();
    } catch (e) {
      log.error('shutdown_error', { module: 'index', error: e.message });
    }
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
});
