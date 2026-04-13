/**
 * Trader Harness — Capability Adapter.
 *
 * Bridges the kernel capability gateway to the old toolExecutor interface
 * used by agent/loop.mjs and agent/telegram/. During migration, provides
 * a fallback to the old executor for any tool not yet registered in kernel.
 *
 * Implements the same interface as agent/tools/executor.mjs:
 *   { execute, getToolDefs, needsConfirmation, describeAction }
 */

import { toOpenAITools } from '../../../kernel/capability/adapters/openai.mjs';

/**
 * Create a kernel-backed tool adapter with old executor fallback.
 *
 * @param {{
 *   gateway: import('../../../kernel/capability/gateway.mjs').CapabilityGateway,
 *   registry: import('../../../kernel/capability/registry.mjs').CapabilityRegistry,
 *   oldExecutor: { execute: Function, getToolDefs: Function, needsConfirmation: Function, describeAction: Function },
 *   oldRegistry: { needsConfirmation: Function, describeAction: Function },
 *   log?: object
 * }} deps
 * @returns {{ execute, getToolDefs, needsConfirmation, describeAction }}
 */
export function createKernelToolAdapter({ gateway, registry, oldExecutor, oldRegistry, log }) {
  const _log = log || { info() {}, warn() {}, error() {} };

  /**
   * Execute a tool by name. Routes through kernel gateway if registered,
   * otherwise falls back to old executor.
   *
   * @param {string} name - flat tool name (e.g. 'price', 'open_trade')
   * @param {object} args
   * @returns {Promise<string>}
   */
  async function execute(name, args) {
    const kernelName = `trader.${name}`;

    if (registry.has(kernelName)) {
      // Registered in kernel — execute through gateway.
      // Do NOT catch errors here: mandate vetoes, validation failures,
      // and handler errors must propagate to the caller.
      return await gateway.execute(kernelName, args);
    }

    // Not registered in kernel yet — use old executor
    return oldExecutor.execute(name, args);
  }

  /**
   * Get OpenAI-format tool definitions.
   * Uses kernel registry (with trader. prefix stripped for compatibility).
   */
  function getToolDefs() {
    // Merge kernel + legacy defs, dedup by name (kernel wins)
    const kernelSchemas = registry.list({ name_prefix: 'trader.' });
    const kernelNames = new Set(kernelSchemas.map(c => c.name.replace(/^trader\./, '')));

    // Kernel-backed tools (strip trader. prefix for LLM compatibility)
    const kernelDefs = kernelSchemas.map(cap => ({
      type: 'function',
      function: {
        name: cap.name.replace(/^trader\./, ''),
        description: cap.description,
        parameters: cap.input_schema || { type: 'object', properties: {}, required: [] },
      },
    }));

    // Legacy tools not yet in kernel
    const legacyDefs = oldExecutor.getToolDefs().filter(
      td => !kernelNames.has(td.function?.name || td.name)
    );

    return [...kernelDefs, ...legacyDefs];
  }

  /**
   * Check if a tool call needs user confirmation.
   * Delegates to old registry (confirmation logic stays in TG bot layer).
   */
  function needsConfirmation(name, args) {
    return oldRegistry.needsConfirmation(name, args);
  }

  /**
   * Generate human-readable description of a tool action.
   * Delegates to old registry (confirmation UI stays in TG bot layer).
   */
  function describeAction(name, args) {
    return oldRegistry.describeAction(name, args);
  }

  return { execute, getToolDefs, needsConfirmation, describeAction };
}
