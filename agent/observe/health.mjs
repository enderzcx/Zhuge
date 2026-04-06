/**
 * System health monitoring — periodic CPU/memory/heap sampling.
 * Feeds into metrics table for Dashboard display.
 */

import { cpus, freemem, totalmem } from 'os';

const SAMPLE_INTERVAL = 60 * 1000; // 1 min
const ALERT_COOLDOWN = 30 * 60 * 1000; // 30 min

const THRESHOLDS = {
  rss_mb:         400,  // RSS absolute — more meaningful than heap_pct (V8 heap % is normally 90%+)
  event_loop_ms:  500,
  mem_pct:         90,
};

export function createHealthMonitor(metrics, { log, alertFn } = {}) {
  let timer = null;
  let prevCpuUsage = null;
  /** @type {Record<string, number>} last alert timestamp per type */
  const lastAlert = {};

  function _maybeAlert(type, value, threshold) {
    if (value <= threshold) return;
    const now = Date.now();
    if (lastAlert[type] && now - lastAlert[type] < ALERT_COOLDOWN) return;
    lastAlert[type] = now;
    const rounded = Math.round(value * 10) / 10;
    const msg = `Health alert: ${type} = ${rounded} (threshold ${threshold})`;
    if (log) log.warn('health_alert', { type, value, threshold });
    if (alertFn) alertFn(msg);
  }

  function _checkThresholds(rssMb, memPct) {
    _maybeAlert('rss_mb', rssMb, THRESHOLDS.rss_mb);
    _maybeAlert('mem_pct', memPct, THRESHOLDS.mem_pct);
  }

  function sample() {
    // Heap
    const heap = process.memoryUsage();
    const rssMb = Math.round(heap.rss / 1024 / 1024);
    metrics.record('system_heap_mb', Math.round(heap.heapUsed / 1024 / 1024));
    metrics.record('system_rss_mb', rssMb);

    // System memory
    const totalMem = totalmem();
    const freeMem = freemem();
    const usedPct = ((totalMem - freeMem) / totalMem * 100);
    metrics.record('system_mem_pct', Math.round(usedPct * 10) / 10);

    // CPU usage (rough estimate via os.cpus)
    const cpuArr = cpus();
    const total = cpuArr.reduce((s, c) => {
      const t = Object.values(c.times).reduce((a, b) => a + b, 0);
      return { idle: s.idle + c.times.idle, total: s.total + t };
    }, { idle: 0, total: 0 });

    if (prevCpuUsage) {
      const idleDiff = total.idle - prevCpuUsage.idle;
      const totalDiff = total.total - prevCpuUsage.total;
      if (totalDiff > 0) {
        const cpuPct = ((1 - idleDiff / totalDiff) * 100);
        metrics.record('system_cpu_pct', Math.round(cpuPct * 10) / 10);
      }
    }
    prevCpuUsage = total;

    // Check non-async thresholds
    _checkThresholds(rssMb, usedPct);

    // Event loop latency (rough)
    const start = performance.now();
    setImmediate(() => {
      const lag = performance.now() - start;
      metrics.record('system_event_loop_ms', Math.round(lag * 100) / 100);
      _maybeAlert('event_loop_ms', lag, THRESHOLDS.event_loop_ms);
    });
  }

  function start() {
    if (timer) return;
    sample(); // immediate first sample
    timer = setInterval(sample, SAMPLE_INTERVAL);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  /**
   * Get current snapshot (for API/TG queries).
   */
  function snapshot() {
    const heap = process.memoryUsage();
    const totalMem = totalmem();
    const freeMem = freemem();
    return {
      heap_mb: Math.round(heap.heapUsed / 1024 / 1024),
      rss_mb: Math.round(heap.rss / 1024 / 1024),
      mem_total_mb: Math.round(totalMem / 1024 / 1024),
      mem_free_mb: Math.round(freeMem / 1024 / 1024),
      mem_pct: Math.round((totalMem - freeMem) / totalMem * 1000) / 10,
      uptime_h: Math.round(process.uptime() / 36) / 100,
      cpus: cpus().length,
    };
  }

  return { start, stop, snapshot };
}
