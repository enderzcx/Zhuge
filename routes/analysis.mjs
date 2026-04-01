/**
 * Analysis routes: signals, analysis, health, observability, refresh.
 * Extracted from vps-api-index.mjs lines ~2382-2453.
 */

export function registerAnalysisRoutes(app, { cache, agentMetrics, priceStream, config, pipeline, db, signals }) {

  const rawDb = db.db; // better-sqlite3 instance

  app.get('/api/signals', (req, res) => {
    const mode = req.query.mode === 'stock' ? 'stock' : 'crypto';
    const c = cache[mode];
    if (!c.analysis) return res.json({ error: 'First analysis in progress.', mode });
    res.json(c.analysis);
  });

  app.get('/api/analysis', (req, res) => {
    const mode = req.query.mode === 'stock' ? 'stock' : 'crypto';
    const c = cache[mode];
    if (!c.analysis) return res.json({ error: 'Not ready.', mode });
    res.json({ token: req.query.token || (mode === 'stock' ? 'SPX' : 'ETH'), ...c.analysis, last_update: c.lastUpdate });
  });

  app.get('/api/health', (req, res) => {
    const newsCount = rawDb.prepare('SELECT COUNT(*) as cnt FROM news').get().cnt;
    const analysisCount = rawDb.prepare('SELECT COUNT(*) as cnt FROM analysis').get().cnt;
    res.json({
      status: 'ok',
      modes: {
        crypto: { last_update: cache.crypto.lastUpdate, cached: !!cache.crypto.analysis, push_worthy: cache.crypto.analysis?.push_worthy || false },
        stock:  { last_update: cache.stock.lastUpdate, cached: !!cache.stock.analysis },
      },
      agents: ['analyst', 'risk', 'strategist', 'executor', 'reviewer'],
      db: { news: newsCount, analysis: analysisCount, strategies: rawDb.prepare('SELECT COUNT(*) as cnt FROM strategies WHERE status = ?').get('active').cnt },
      ws: { connected: priceStream.wsConnected, pairs: config.PRICE_PAIRS || ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'], prices: Object.fromEntries((config.PRICE_PAIRS || ['BTC-USDT', 'ETH-USDT', 'SOL-USDT']).map(p => [p, priceStream.priceCache[p]?.price || 0])) },
      crucix: config.CRUCIX,
      llm: config.LLM_MODEL,
      uptime_s: Math.round(process.uptime()),
    });
  });

  app.get('/api/observability', (req, res) => {
    const agents = {};
    for (const [name, m] of Object.entries(agentMetrics)) {
      agents[name] = {
        calls: m.calls,
        errors: m.errors,
        error_rate: m.calls > 0 ? ((m.errors / m.calls) * 100).toFixed(1) + '%' : '0%',
        avg_ms: m.calls > 0 ? Math.round(m.total_ms / m.calls) : 0,
        avg_tokens: m.calls > 0 ? Math.round(m.total_tokens / m.calls) : 0,
        total_tokens: m.total_tokens,
        last_run: m.last_run,
      };
    }
    const signalScoreCount = rawDb.prepare('SELECT COUNT(*) as cnt FROM signal_scores').get().cnt;
    const lessonsActive = rawDb.prepare('SELECT COUNT(*) as cnt FROM lessons WHERE active = 1').get().cnt;
    const candleCount = rawDb.prepare('SELECT COUNT(*) as cnt FROM candles').get().cnt;
    const lastWeekly = rawDb.prepare("SELECT timestamp FROM decisions WHERE agent = 'reviewer' AND action = 'weekly_review' ORDER BY timestamp DESC LIMIT 1").get();

    res.json({
      agents,
      models: config.AGENT_MODELS,
      learning_loop: {
        candles_stored: candleCount,
        signals_scored: signalScoreCount,
        active_lessons: lessonsActive,
        source_weights: signals.getSourceWeights(),
        last_weekly_review: lastWeekly?.timestamp || null,
      },
      uptime_s: Math.round(process.uptime()),
      memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    });
  });

  app.post('/api/refresh', async (req, res) => {
    const anyAnalyzing = cache.crypto.analyzing || cache.stock.analyzing;
    if (anyAnalyzing) return res.json({ status: 'already_running' });
    pipeline.collectAndAnalyze();
    res.json({ status: 'started' });
  });
}
