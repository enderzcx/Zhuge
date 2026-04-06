/**
 * VPS entry point: wire all modules and start the server.
 */

import express from 'express';
import { createConfig } from './config.mjs';
import { createDB } from './db.mjs';
import { createLLM } from './llm.mjs';
import { createBitgetClient } from './bitget/client.mjs';
import { createBitgetExecutor } from './bitget/executor.mjs';
import { registerBitgetRoutes } from './bitget/routes.mjs';
import { createMessageBus } from './agents/message-bus.mjs';
import { createAgentRunner } from './agents/runner.mjs';
import { createAnalyst } from './agents/analyst.mjs';
import { createRiskAgent } from './agents/risk.mjs';
import { createStrategist } from './agents/strategist.mjs';
import { createReviewer } from './agents/reviewer.mjs';
import { createResearcher } from './agents/researcher.mjs';
import { createPriceStream } from './market/prices.mjs';
import { createSignalScoring } from './market/signals.mjs';
import { createScanner } from './market/scanner.mjs';
import * as indicators from './market/indicators.mjs';
import { createDataSources } from './integrations/data-sources.mjs';
import { createLiFi, registerLiFiRoutes } from './integrations/lifi.mjs';
import { createTelegram } from './integrations/telegram.mjs';
import { createPipeline } from './pipeline.mjs';
// Observability
import { createMetrics } from './agent/observe/metrics.mjs';
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
import { createPromptLoader } from './agent/prompts/loader.mjs';
import { createConfirmHandler } from './agent/telegram/confirm.mjs';
import { createAgentBot } from './agent/telegram/bot.mjs';
import { createProvenance } from './agent/cognition/provenance.mjs';
import { createCompound } from './agent/cognition/compound.mjs';
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
const db = createDB();
const metrics = createMetrics(db.db);
const { log, readLogs } = createLogger();
// alertFn wired after pushEngine creation below
const _alertRef = { fn: null };
const health = createHealthMonitor(metrics, { log, alertFn: (msg) => _alertRef.fn?.(msg) });
health.start();
const llm = createLLM(config);
const bitgetClient = createBitgetClient(config, { metrics, log });
const messageBus = createMessageBus({ db });
const agentRunner = createAgentRunner({ config, db, messageBus, metrics, log });
const dataSources = createDataSources(config);
const priceStream = createPriceStream({ db, config, log, metrics });
const signals = createSignalScoring({ db });
const lifi = createLiFi(config);
const analyst = createAnalyst({ db, config, bitgetClient, dataSources, priceStream, indicators });
const riskAgent = createRiskAgent({ db, config, bitgetClient, agentRunner, messageBus, log });
const cache = {
  crypto: { analysis: null, lastUpdate: null, analyzing: false, patrolHistory: [], patrolCounter: 0 },
  stock:  { analysis: null, lastUpdate: null, analyzing: false, patrolHistory: [], patrolCounter: 0 },
};
const strategist = createStrategist({ db, agentRunner, messageBus, cache, log });
const telegram = createTelegram({ db, config, agentMetrics: agentRunner.agentMetrics, cache });
const reviewer = createReviewer({ db, config, agentRunner, messageBus, telegram, log });
// reviewer created first so checkAndSyncTrades can trigger lesson generation after trade close
const bitgetExec = createBitgetExecutor({ db, config, bitgetClient, messageBus, reviewer, log, metrics });
const researcher = createResearcher({ db, config, bitgetClient, agentRunner, indicators, dataSources, log });
const _compoundRef = { instance: null };
const scanner = createScanner({ db, config, bitgetClient, agentRunner, indicators, tradingLock: bitgetExec.tradingLock, researcher, compound: { getParamOverrides: () => _compoundRef.instance?.getParamOverrides() || {} }, log, metrics });
// Push engine created after agentBot (needs tgSend)
let pushEngine = null; // initialized after bot creation

// --- Agent Harness (Phase 2) ---
const agentLLM = createAgentLLM(config, { log, metrics });
const agentHistory = createHistory({ llm });
const modelSelector = createModelSelector(config);
const toolRegistry = createToolRegistry();
const agentProvenance = createProvenance({ db: db.db, log });
const agentCompound = createCompound({ db: db.db, llm, provenance: agentProvenance, log, metrics });
_compoundRef.instance = agentCompound; // wire into scanner via getter

// --- RAG Knowledge Base ---
const rag = createRAG({ config, log });
await rag.init();
await rag.seed('data/seed-knowledge.json').catch(e => log.warn('rag_seed_failed', { module: 'index', error: e.message }));

// Register tools
const systemTools = createSystemTools({ log });
// pushEngine is null here, will be set after bot creation. Use getter pattern.
const _pushRef = { engine: null };
const dataTools = createDataTools({
  dataSources, priceStream, db: db.db, scanner,
  pushEngine: { getRecentContext: (...a) => _pushRef.engine?.getRecentContext(...a) || [] },
  compound: agentCompound, readLogs, rag,
});
const tradeTools = createTradeTools({ bitgetClient, bitgetExec, db, config });
const memoryTools = createMemoryTools({ log });
toolRegistry.registerAll([...systemTools.TOOL_DEFS, ...dataTools.TOOL_DEFS, ...tradeTools.TOOL_DEFS, ...memoryTools.TOOL_DEFS]);

const toolExecutor = createToolExecutor({ registry: toolRegistry, log, metrics });
toolExecutor.registerExecutors({ ...systemTools.EXECUTORS, ...dataTools.EXECUTORS, ...tradeTools.EXECUTORS, ...memoryTools.EXECUTORS });

const promptLoader = createPromptLoader({
  db: db.db,
  pushEngine: { getRecentContext: (...a) => _pushRef.engine?.getRecentContext(...a) || [] },
  dataSources,
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
const pipeline = createPipeline({ config, db, dataSources, analyst, riskAgent, bitgetExec, strategist, reviewer, priceStream, scanner, signals, telegram, agentRunner, cache, messageBus, llm, metrics, log, pushEngine });

// --- Register routes ---
registerAnalysisRoutes(app, { cache, agentMetrics: agentRunner.agentMetrics, priceStream, config, pipeline, db, signals });
registerTradeRoutes(app, { db });
registerDecisionRoutes(app, { db });
registerHistoryRoutes(app, { db });
registerStrategyRoutes(app, { db });
registerLearningRoutes(app, { db, signals });
registerMarketRoutes(app, { db, priceStream });
registerBitgetRoutes(app, { bitgetClient, log });
registerLiFiRoutes(app, lifi);

// --- Anomaly handler (price spike -> instant analysis) ---
priceStream.setAnomalyHandler((anomaly) => {
  pipeline.collectAndAnalyze()
    .catch(err => log.error('anomaly_analysis_error', { module: 'index', error: err.message }))
    .finally(() => scanner.reviewPendingOrders().catch(e => log.error('pending_review_error', { module: 'index', error: e.message })));
});

// --- Start ---
app.listen(config.PORT, () => {
  log.info('server_started', { module: 'index', port: config.PORT, model: config.LLM_MODEL, interval: '30min' });
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
  // Check for filled/closed positions every 5 minutes + review pending orders
  setInterval(() => {
    bitgetExec.checkAndSyncTrades().catch(e => log.error('trade_sync_error', { module: 'index', error: e.message }));
    scanner.reviewPendingOrders().catch(e => log.error('pending_review_error', { module: 'index', error: e.message }));
  }, 5 * 60 * 1000);
  priceStream.connectOKXWebSocket();

  // Start TG bot
  if (config.TG_BOT_TOKEN) {
    agentBot.startPolling();
    log.info('agent_bot_started', { module: 'index' });
    // Dashboard: scheduled TG posts (positions, observe, charts)
    const dashboard = createDashboard({ config, db: db.db, tgCall: agentBot.tgCall, health, metrics, log, dataSources, llm });
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
      health.stop();
      // Sync trades one last time (detect fills before exit)
      await bitgetExec.checkAndSyncTrades().catch(() => {});
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
