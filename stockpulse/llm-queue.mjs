/**
 * LLM Request Queue — priority-based dispatcher.
 * Single LLM endpoint, multiple consumers (TradeAgent + StockPulse).
 * Prevents mutual blocking via priority queue + serial execution.
 */

export function createLLMQueue({ llm, eventBus }) {
  const queue = [];
  let processing = false;
  let totalCalls = 0;
  let totalErrors = 0;
  let totalTokens = 0;

  const eb = eventBus || { emit() {} };

  /**
   * Enqueue an LLM request.
   * @param {number} priority - 0 (highest) to 5 (lowest)
   * @param {Array} messages - Chat messages
   * @param {object} opts - LLM options (model, max_tokens, temperature, timeout)
   * @returns {Promise<object>} LLM response
   */
  function enqueue(priority, messages, opts = {}) {
    return new Promise((resolve, reject) => {
      queue.push({ priority, messages, opts, resolve, reject, enqueued: Date.now() });
      // Re-sort by priority (stable: same priority keeps FIFO order)
      queue.sort((a, b) => a.priority - b.priority || a.enqueued - b.enqueued);
      eb.emit('system.llm.queued', { priority, queueDepth: queue.length });
      drain();
    });
  }

  async function drain() {
    if (processing || queue.length === 0) return;
    processing = true;

    while (queue.length > 0) {
      const job = queue.shift();
      const start = Date.now();
      try {
        const result = await llm(job.messages, job.opts);
        totalCalls++;
        totalTokens += result.tokens?.total || 0;
        eb.emit('system.llm.completed', {
          priority: job.priority,
          duration_ms: Date.now() - start,
          tokens: result.tokens?.total || 0,
          queueWait_ms: start - job.enqueued,
        });
        job.resolve(result);
      } catch (err) {
        totalCalls++;
        totalErrors++;
        eb.emit('system.llm.error', {
          priority: job.priority,
          error: err.message,
          duration_ms: Date.now() - start,
        });
        job.reject(err);
      }
    }

    processing = false;
  }

  function pending() { return queue.length; }

  function metrics() {
    return { totalCalls, totalErrors, totalTokens, queueDepth: queue.length, errorRate: totalCalls ? +(totalErrors / totalCalls * 100).toFixed(1) : 0 };
  }

  return { enqueue, pending, metrics };
}
