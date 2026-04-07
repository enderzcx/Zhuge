/**
 * Prometheus exporter — dual-write wrapper around metrics.record().
 * Wraps existing SQLite metrics to also update prom-client gauges/histograms/counters.
 * Exposes /metrics endpoint for Grafana scraping.
 */

import client from 'prom-client';

export function createPrometheus(metrics) {
  const register = new client.Registry();
  client.collectDefaultMetrics({ register, prefix: 'zhuge_' });

  // --- Histograms ---
  const llmLatency = new client.Histogram({
    name: 'zhuge_llm_latency_seconds',
    help: 'LLM call latency',
    labelNames: ['agent', 'model'],
    buckets: [1, 5, 10, 20, 30, 60],
    registers: [register],
  });

  const bitgetLatency = new client.Histogram({
    name: 'zhuge_bitget_api_latency_seconds',
    help: 'Bitget API latency',
    labelNames: ['method', 'path'],
    buckets: [0.05, 0.1, 0.2, 0.5, 1, 2],
    registers: [register],
  });

  const pipelineDuration = new client.Histogram({
    name: 'zhuge_pipeline_duration_seconds',
    help: 'Pipeline cycle duration',
    buckets: [10, 20, 30, 60, 120, 300],
    registers: [register],
  });

  const tgReplyLatency = new client.Histogram({
    name: 'zhuge_tg_reply_latency_seconds',
    help: 'TG bot reply latency',
    buckets: [1, 5, 10, 20, 30, 60],
    registers: [register],
  });

  const toolLatency = new client.Histogram({
    name: 'zhuge_tool_latency_seconds',
    help: 'Agent tool execution latency',
    labelNames: ['tool'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
    registers: [register],
  });

  // --- Counters ---
  const llmTokens = new client.Counter({
    name: 'zhuge_llm_tokens_total',
    help: 'LLM tokens consumed',
    labelNames: ['agent', 'direction'],
    registers: [register],
  });

  const intelItems = new client.Counter({
    name: 'zhuge_intel_items_total',
    help: 'Intel items ingested',
    labelNames: ['source'],
    registers: [register],
  });

  const tgMessages = new client.Counter({
    name: 'zhuge_tg_messages_total',
    help: 'TG messages received',
    registers: [register],
  });

  const errors = new client.Counter({
    name: 'zhuge_errors_total',
    help: 'Error count by module',
    labelNames: ['module', 'type'],
    registers: [register],
  });

  // --- Gauges ---
  const systemHeap = new client.Gauge({ name: 'zhuge_system_heap_mb', help: 'V8 heap MB', registers: [register] });
  const systemRss = new client.Gauge({ name: 'zhuge_system_rss_mb', help: 'RSS MB', registers: [register] });
  const systemCpu = new client.Gauge({ name: 'zhuge_system_cpu_pct', help: 'CPU %', registers: [register] });
  const systemMem = new client.Gauge({ name: 'zhuge_system_mem_pct', help: 'System memory %', registers: [register] });
  const systemEventLoop = new client.Gauge({ name: 'zhuge_system_event_loop_ms', help: 'Event loop latency ms', registers: [register] });

  const analysisConfidence = new client.Gauge({ name: 'zhuge_analysis_confidence', help: 'Latest analysis confidence', registers: [register] });
  const fearGreed = new client.Gauge({ name: 'zhuge_fear_greed_index', help: 'Fear & Greed Index', registers: [register] });

  // --- Metric name → Prometheus update mapping ---
  const METRIC_MAP = {
    llm_latency_ms:        (v, t) => llmLatency.observe({ agent: t.agent || t.module || '', model: t.model || '' }, v / 1000),
    llm_tokens_in:         (v, t) => llmTokens.inc({ agent: t.agent || t.module || '', direction: 'in' }, v),
    llm_tokens_out:        (v, t) => llmTokens.inc({ agent: t.agent || t.module || '', direction: 'out' }, v),
    bitget_api_latency_ms: (v, t) => bitgetLatency.observe({ method: t.method || '', path: (t.path || '').slice(0, 40) }, v / 1000),
    collect_cycle_ms:      (v) => pipelineDuration.observe(v / 1000),
    data_collect_ms:       (v) => pipelineDuration.observe(v / 1000),
    tg_reply_latency_ms:   (v) => tgReplyLatency.observe(v / 1000),
    tg_msg_received:       () => tgMessages.inc(),
    agent_tool_ms:         (v, t) => toolLatency.observe({ tool: t.tool || '' }, v / 1000),
    error_count:           (v, t) => errors.inc({ module: t.module || '', type: t.type || '' }, v),
    system_heap_mb:        (v) => systemHeap.set(v),
    system_rss_mb:         (v) => systemRss.set(v),
    system_cpu_pct:        (v) => systemCpu.set(v),
    system_mem_pct:        (v) => systemMem.set(v),
    system_event_loop_ms:  (v) => systemEventLoop.set(v),
    // Custom intel metric (recorded from intel.mjs)
    intel_ingested:        (v, t) => intelItems.inc({ source: t.source || '' }, v),
  };

  // --- Wrap existing metrics.record() ---
  const originalRecord = metrics.record.bind(metrics);
  metrics.record = function wrappedRecord(name, value, tags = {}) {
    // Original SQLite write
    originalRecord(name, value, tags);
    // Prometheus update
    try {
      const handler = METRIC_MAP[name];
      if (handler) handler(value, tags);
    } catch { /* never break the app */ }
  };

  return {
    contentType: register.contentType,
    metricsText: () => register.metrics(),
    register,
    // Expose gauges for direct set from outside
    setConfidence: (v) => { try { analysisConfidence.set(v); } catch {} },
    setFearGreed: (v) => { try { fearGreed.set(v); } catch {} },
  };
}
