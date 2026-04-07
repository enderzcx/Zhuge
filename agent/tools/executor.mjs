/**
 * Tool executor — routes tool calls to implementations, handles budgeting.
 *
 * Wraps the registry with actual executor functions.
 * Delegates needsConfirmation/describeAction to registry.
 */

import { startChildSpan, endSpan } from '../observe/tracing.mjs';
import { context } from '@opentelemetry/api';

export function createToolExecutor({ registry, log, metrics }) {
  const _log = log || { info() {}, warn() {}, error() {} };
  const _m = metrics || { record() {} };

  // name → async (args) => result
  const executors = new Map();

  /**
   * Register an executor function for a tool.
   */
  function registerExecutor(name, fn) {
    executors.set(name, fn);
  }

  /**
   * Register multiple executors at once.
   * @param {Record<string, Function>} map - { toolName: async (args) => result }
   */
  function registerExecutors(map) {
    for (const [name, fn] of Object.entries(map)) {
      executors.set(name, fn);
    }
  }

  /**
   * Execute a tool by name.
   * @param {string} name
   * @param {object} args
   * @returns {string} result (budgeted)
   */
  async function execute(name, args) {
    const fn = executors.get(name);
    if (!fn) {
      _log.warn('unknown_tool', { module: 'executor', tool: name });
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    }

    const { span } = startChildSpan(context.active(), `tool:${name}`, { tool: name });
    try {
      const result = await fn(args);
      const str = typeof result === 'string' ? result : JSON.stringify(result);

      // Budget output
      const meta = registry.getToolMeta(name);
      const maxChars = meta?.maxResultChars || 2000;
      endSpan(span);
      if (str.length > maxChars) {
        return str.slice(0, maxChars) + `\n...[truncated ${str.length - maxChars} chars]`;
      }
      return str;
    } catch (err) {
      endSpan(span, err);
      _log.error('tool_exec_error', { module: 'executor', tool: name, error: err.message });
      _m.record('error_count', 1, { module: 'executor', type: name });
      return JSON.stringify({ error: err.message });
    }
  }

  // Delegate to registry
  function getToolDefs() { return registry.getToolDefs(); }
  function needsConfirmation(name, args) { return registry.needsConfirmation(name, args); }
  function describeAction(name, args) { return registry.describeAction(name, args); }

  return { registerExecutor, registerExecutors, execute, getToolDefs, needsConfirmation, describeAction };
}
