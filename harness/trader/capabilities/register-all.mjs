/**
 * Trader Harness — Register all 64 tools as kernel capabilities.
 *
 * Takes the existing TOOL_DEFS + EXECUTORS from 6 tool modules and
 * registers them in the kernel capability registry with:
 *   - 'trader.' namespace prefix
 *   - Original handler wrapped as async (input) => string
 *   - Tags by category for lazy loading
 *   - mandate_check: true for trade execution tools
 *
 * Does NOT delete or modify the original tool modules.
 */

/** Tools that require mandate gate check before execution. */
const MANDATE_CHECKED_TOOLS = new Set([
  'open_trade',
  'close_trade',
  'pause_trading',
  'resume_trading',
]);

/** Tool category tags for filtering. */
const TOOL_TAGS = {
  data: ['data', 'read'],
  trade: ['trade'],
  memory: ['memory'],
  schedule: ['schedule'],
  system: ['system'],
  tradingview: ['data', 'tradingview'],
};

/**
 * Register all trader tools from a tool module into the kernel registry.
 *
 * @param {import('../../../kernel/capability/registry.mjs').CapabilityRegistry} registry
 * @param {string} category - tool category name
 * @param {{ TOOL_DEFS: object[], EXECUTORS: Record<string, Function> }} toolModule
 */
function registerCategory(registry, category, toolModule) {
  const { TOOL_DEFS, EXECUTORS } = toolModule;
  const tags = TOOL_TAGS[category] || [category];

  for (const def of TOOL_DEFS) {
    const executorFn = EXECUTORS[def.name];
    if (!executorFn) continue; // Skip tools with no executor (shouldn't happen)

    const kernelName = `trader.${def.name}`;

    registry.register({
      name: kernelName,
      description: def.description,
      input_schema: def.parameters || { type: 'object', properties: {}, required: [] },
      tags,
      mandate_check: MANDATE_CHECKED_TOOLS.has(def.name),
      max_result_chars: def.maxResultChars || 2000,
      handler: async (input) => {
        const result = await executorFn(input);
        return typeof result === 'string' ? result : JSON.stringify(result);
      },
    });
  }
}

/**
 * Register all 64 trader tools into the kernel capability registry.
 *
 * @param {import('../../../kernel/capability/registry.mjs').CapabilityRegistry} registry
 * @param {{
 *   dataTools: { TOOL_DEFS: object[], EXECUTORS: object },
 *   tradeTools: { TOOL_DEFS: object[], EXECUTORS: object },
 *   memoryTools: { TOOL_DEFS: object[], EXECUTORS: object },
 *   scheduleTools: { TOOL_DEFS: object[], EXECUTORS: object },
 *   systemTools: { TOOL_DEFS: object[], EXECUTORS: object },
 *   tradingviewTools: { TOOL_DEFS: object[], EXECUTORS: object },
 * }} toolModules
 * @returns {number} count of registered capabilities
 */
export function registerAllTraderCapabilities(registry, toolModules) {
  const {
    dataTools,
    tradeTools,
    memoryTools,
    scheduleTools,
    systemTools,
    tradingviewTools,
  } = toolModules;

  registerCategory(registry, 'data', dataTools);
  registerCategory(registry, 'trade', tradeTools);
  registerCategory(registry, 'memory', memoryTools);
  registerCategory(registry, 'schedule', scheduleTools);
  registerCategory(registry, 'system', systemTools);
  registerCategory(registry, 'tradingview', tradingviewTools);

  return registry.size();
}
