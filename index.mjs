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
// Agent Harness — TG Agent
import { createAgentLLM } from './agent/llm.mjs';
import { createHistory } from './agent/history.mjs';
import { createModelSelector } from './agent/model-select.mjs';
import { createToolRegistry } from './agent/tools/registry.mjs';
import { createToolExecutor } from './agent/tools/executor.mjs';
import { createSystemTools } from './agent/tools/system.mjs';
import { createDataTools } from './agent/tools/data.mjs';
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
// StockPulse Telegram Bot (deprecated, kept for backward compat if AGENT_BOT not configured)
import { createLLMQueue } from './stockpulse/llm-queue.mjs';
import { createPushEngine as createSPPushEngine } from './stockpulse/push-engine.mjs';
import { createAIAnalyst } from './stockpulse/ai-analyst.mjs';
import { createStockPulseBot } from './stockpulse/telegram-bot.mjs';
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
const db = createDB();
const metrics = createMetrics(db.db);
const { log } = createLogger();
const health = createHealthMonitor(metrics);
health.start();
const llm = createLLM(config);
const bitgetClient = createBitgetClient(config);
const messageBus = createMessageBus({ db });
const agentRunner = createAgentRunner({ config, db, messageBus });
const dataSources = createDataSources(config);
const priceStream = createPriceStream({ db, config });
const signals = createSignalScoring({ db });
const lifi = createLiFi(config);
const analyst = createAnalyst({ db, config, bitgetClient, dataSources, priceStream, indicators });
const riskAgent = createRiskAgent({ db, config, bitgetClient, agentRunner, messageBus });
const cache = {
  crypto: { analysis: null, lastUpdate: null, analyzing: false, patrolHistory: [], patrolCounter: 0 },
  stock:  { analysis: null, lastUpdate: null, analyzing: false, patrolHistory: [], patrolCounter: 0 },
};
const strategist = createStrategist({ db, agentRunner, messageBus, cache });
const telegram = createTelegram({ db, config, agentMetrics: agentRunner.agentMetrics, cache });
const reviewer = createReviewer({ db, config, agentRunner, messageBus, telegram });
// reviewer created first so checkAndSyncTrades can trigger lesson generation after trade close
const bitgetExec = createBitgetExecutor({ db, config, bitgetClient, messageBus, reviewer });
const researcher = createResearcher({ db, config, bitgetClient, agentRunner, indicators, dataSources });
const scanner = createScanner({ db, config, bitgetClient, agentRunner, indicators, tradingLock: bitgetExec.tradingLock, researcher });
// Push engine created after agentBot (needs tgSend)
let pushEngine = null; // initialized after bot creation

// --- Agent Harness (Phase 2) ---
const agentLLM = createAgentLLM(config, { log, metrics });
const agentHistory = createHistory({ llm });
const modelSelector = createModelSelector(config);
const toolRegistry = createToolRegistry();
const agentProvenance = createProvenance({ db: db.db, log });
const agentCompound = createCompound({ db: db.db, llm, provenance: agentProvenance, log, metrics });

// Register tools
const systemTools = createSystemTools({ log });
// pushEngine is null here, will be set after bot creation. Use getter pattern.
const _pushRef = { engine: null };
const dataTools = createDataTools({ dataSources, priceStream, db: db.db, scanner, pushEngine: { getRecentContext: (...a) => _pushRef.engine?.getRecentContext(...a) || [] } });
const tradeTools = createTradeTools({ bitgetClient, bitgetExec, db, config });
const memoryTools = createMemoryTools({ log });
toolRegistry.registerAll([...systemTools.TOOL_DEFS, ...dataTools.TOOL_DEFS, ...tradeTools.TOOL_DEFS, ...memoryTools.TOOL_DEFS]);

const toolExecutor = createToolExecutor({ registry: toolRegistry, log, metrics });
toolExecutor.registerExecutors({ ...systemTools.EXECUTORS, ...dataTools.EXECUTORS, ...tradeTools.EXECUTORS, ...memoryTools.EXECUTORS });

const promptLoader = createPromptLoader({ db: db.db, pushEngine: { getRecentContext: (...a) => _pushRef.engine?.getRecentContext(...a) || [] } });
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

// Create pipeline (after push engine)
const pipeline = createPipeline({ config, db, dataSources, analyst, riskAgent, bitgetExec, strategist, reviewer, priceStream, scanner, signals, telegram, agentRunner, cache, messageBus, llm, metrics, log, pushEngine });

// --- StockPulse Telegram Bot (deprecated — only starts if agent bot token not set) ---
const eventBus = { emit() {} };
const llmQueue = createLLMQueue({ llm, eventBus });
const spPushEngine = createSPPushEngine({ db, config });
const aiAnalyst = createAIAnalyst({ llmQueue, db, config });
const spBot = createStockPulseBot({ config, pushEngine: spPushEngine, aiAnalyst, dataSources });

// --- Register routes ---
registerAnalysisRoutes(app, { cache, agentMetrics: agentRunner.agentMetrics, priceStream, config, pipeline, db, signals });
registerTradeRoutes(app, { db });
registerDecisionRoutes(app, { db });
registerHistoryRoutes(app, { db });
registerStrategyRoutes(app, { db });
registerLearningRoutes(app, { db, signals });
registerMarketRoutes(app, { db, priceStream });
registerBitgetRoutes(app, { bitgetClient });
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
  const runAnalysis = () => pipeline.collectAndAnalyze()
    .finally(() => scanner.reviewPendingOrders().catch(e => log.error('pending_review_error', { module: 'index', error: e.message })));
  runAnalysis();
  setInterval(runAnalysis, 30 * 60 * 1000); // 30min (was 15min, saves ~50% tokens)
  // Check for filled/closed positions every 5 minutes + review pending orders
  setInterval(() => {
    bitgetExec.checkAndSyncTrades().catch(e => log.error('trade_sync_error', { module: 'index', error: e.message }));
    scanner.reviewPendingOrders().catch(e => log.error('pending_review_error', { module: 'index', error: e.message }));
  }, 5 * 60 * 1000);
  priceStream.connectOKXWebSocket();

  // Start TG bot — agent harness replaces StockPulse bot
  if (config.TG_BOT_TOKEN) {
    agentBot.startPolling();
    log.info('agent_bot_started', { module: 'index' });
    // Dashboard: scheduled TG posts (positions, observe, charts)
    const dashboard = createDashboard({ config, db: db.db, tgCall: agentBot.tgCall, health, metrics, log });
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
  } else {
    spBot.start(); // fallback to old StockPulse bot
    log.info('stockpulse_bot_started', { module: 'index' });
  }
});
