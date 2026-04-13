/**
 * Kernel Observability — event-driven metric/trace pipeline.
 *
 * Subscribes to event store events and produces metrics.
 * Harness emits events, kernel auto-generates metrics — no manual record() calls.
 *
 * Sprint 3: in-memory metric counters + subscription API.
 * Future: plug into Prometheus / OTel exporters.
 */

/**
 * Create an Observability instance.
 * @param {{ eventStore?: import('../event-store/index.mjs').EventStore, log?: object }} deps
 * @returns {Observability}
 */
export function createObservability({ eventStore, log } = {}) {
  const _log = log || { info() {}, warn() {} };

  /** @type {Array<{ id: string, event_type: string|string[], reducer: Function }>} */
  const subscriptions = [];

  /** @type {Map<string, { value: number, labels: object, updated_at: string }>} */
  const metrics = new Map();

  let _subIdCounter = 0;
  let _pollInterval = null;
  let _lastPollTs = null;
  let _lastPollId = null;

  /**
   * Subscribe to events and auto-generate metrics.
   *
   * @param {{
   *   event_type: string|string[],
   *   reducer: (event: object) => { metric: string, labels?: object, value: number } | null
   * }} opts
   * @returns {string} subscriptionId
   */
  function subscribe({ event_type, reducer }) {
    if (!event_type || !reducer) throw new Error('event_type and reducer are required');
    const id = `obs_${++_subIdCounter}`;
    subscriptions.push({ id, event_type, reducer });
    return id;
  }

  /**
   * Process events since last poll and update metrics.
   * Called periodically or manually.
   */
  function processEvents() {
    if (!eventStore) return;

    // Use _lastPollId to avoid re-processing (ts can have duplicates within same ms)
    const query = {};
    if (_lastPollTs) query.since = _lastPollTs;

    let events = eventStore.getEvents(query);
    // Skip events we've already processed (by filtering out IDs <= last processed)
    if (_lastPollId) {
      const idx = events.findIndex(e => e.id === _lastPollId);
      if (idx >= 0) events = events.slice(idx + 1);
    }
    if (events.length === 0) return;

    for (const event of events) {
      for (const sub of subscriptions) {
        // Check event type match
        const types = Array.isArray(sub.event_type) ? sub.event_type : [sub.event_type];
        if (types.includes('*') || types.includes(event.type)) {
          try {
            const result = sub.reducer(event);
            if (result && result.metric) {
              _updateMetric(result.metric, result.value, result.labels || {});
            }
          } catch (err) {
            _log.warn('observability_reducer_error', { sub: sub.id, error: err.message });
          }
        }
      }
    }

    const lastEvent = events[events.length - 1];
    _lastPollTs = lastEvent.ts;
    _lastPollId = lastEvent.id;
  }

  /**
   * Update a metric value.
   * @param {string} name
   * @param {number} value - added to existing (counter) or replaces (gauge via reset)
   * @param {object} labels
   */
  function _updateMetric(name, value, labels) {
    const labelKey = Object.entries(labels).sort().map(([k, v]) => `${k}=${v}`).join(',');
    const key = labelKey ? `${name}{${labelKey}}` : name;

    const existing = metrics.get(key);
    if (existing) {
      existing.value += value;
      existing.updated_at = new Date().toISOString();
    } else {
      metrics.set(key, {
        value,
        labels,
        updated_at: new Date().toISOString(),
      });
    }
  }

  /**
   * Start periodic event processing.
   * @param {{ interval_ms?: number }} [opts]
   */
  function start(opts = {}) {
    const interval = opts.interval_ms || 10000; // 10s default
    _pollInterval = setInterval(() => processEvents(), interval);
  }

  /**
   * Stop periodic processing.
   */
  function stop() {
    if (_pollInterval) {
      clearInterval(_pollInterval);
      _pollInterval = null;
    }
  }

  /**
   * Get all current metric values.
   * @returns {Array<{ name: string, value: number, labels: object, updated_at: string }>}
   */
  function getMetrics() {
    return [...metrics.entries()].map(([key, m]) => {
      const nameMatch = key.match(/^([^{]+)/);
      return {
        key,
        name: nameMatch ? nameMatch[1] : key,
        value: m.value,
        labels: m.labels,
        updated_at: m.updated_at,
      };
    });
  }

  /**
   * Get a specific metric value.
   * @param {string} name
   * @param {object} [labels]
   * @returns {number|undefined}
   */
  function getMetric(name, labels = {}) {
    const labelKey = Object.entries(labels).sort().map(([k, v]) => `${k}=${v}`).join(',');
    const key = labelKey ? `${name}{${labelKey}}` : name;
    return metrics.get(key)?.value;
  }

  /**
   * Reset all metrics (for testing).
   */
  function reset() {
    metrics.clear();
    _lastPollTs = null;
    _lastPollId = null;
  }

  return { subscribe, processEvents, start, stop, getMetrics, getMetric, reset };
}
