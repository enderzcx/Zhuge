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
// StockPulse Telegram Bot
import { createLLMQueue } from './stockpulse/llm-queue.mjs';
import { createPushEngine } from './stockpulse/push-engine.mjs';
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
const pipeline = createPipeline({ config, db, dataSources, analyst, riskAgent, bitgetExec, strategist, reviewer, priceStream, scanner, signals, telegram, agentRunner, cache, messageBus, llm });

// --- StockPulse Telegram Bot ---
const eventBus = { emit() {} }; // lightweight stub, full eventBus not needed for bot
const llmQueue = createLLMQueue({ llm, eventBus });
const pushEngine = createPushEngine({ db, config });
const aiAnalyst = createAIAnalyst({ llmQueue, db, config });
const spBot = createStockPulseBot({ config, pushEngine, aiAnalyst, dataSources });

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
    .catch(err => console.error('[Anomaly] Analysis error:', err.message))
    .finally(() => scanner.reviewPendingOrders().catch(e => console.error('[PendingReview] Error:', e.message)));
});

// --- Start ---
app.listen(config.PORT, () => {
  console.log(`[VPS-API] Running on :${config.PORT} | LLM: ${config.LLM_MODEL} | Mode: crypto | Interval: 30min | DB: data/rifi.db`);
  const runAnalysis = () => pipeline.collectAndAnalyze()
    .finally(() => scanner.reviewPendingOrders().catch(e => console.error('[PendingReview] Error:', e.message)));
  runAnalysis();
  setInterval(runAnalysis, 30 * 60 * 1000); // 30min (was 15min, saves ~50% tokens)
  // Check for filled/closed positions every 5 minutes + review pending orders
  setInterval(() => {
    bitgetExec.checkAndSyncTrades().catch(e => console.error('[TradeSync] Error:', e.message));
    scanner.reviewPendingOrders().catch(e => console.error('[PendingReview] Error:', e.message));
  }, 5 * 60 * 1000);
  priceStream.connectOKXWebSocket();
  spBot.start(); // StockPulse TG bot polling
});
