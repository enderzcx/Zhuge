/**
 * Tool registry — schema definitions, safety flags, and OpenAI tool_defs builder.
 *
 * Each tool has:
 *   name, description, parameters (JSON Schema),
 *   requiresConfirmation, safePatterns (for exec_shell),
 *   maxResultChars (for output budgeting)
 */

const MAX_RESULT_CHARS = 2000;

/**
 * Register all tools and return { getToolDefs, getToolMeta, allTools }.
 * Tool executors are registered separately in executor.mjs.
 */
export function createToolRegistry() {
  const tools = new Map();

  /**
   * Register a tool.
   * @param {object} def
   * @param {string} def.name
   * @param {string} def.description
   * @param {object} def.parameters - JSON Schema
   * @param {boolean} [def.requiresConfirmation=true]
   * @param {RegExp[]} [def.safePatterns] - patterns that skip confirmation (exec_shell)
   * @param {number} [def.maxResultChars]
   * @param {boolean} [def.isDestructive=false]
   */
  function register(def) {
    tools.set(def.name, {
      requiresConfirmation: true, // fail-closed default
      safePatterns: [],
      maxResultChars: MAX_RESULT_CHARS,
      isDestructive: false,
      ...def,
    });
  }

  /**
   * Register multiple tools at once.
   */
  function registerAll(defs) {
    for (const def of defs) register(def);
  }

  /**
   * Get OpenAI-format tool definitions for LLM call.
   */
  function getToolDefs() {
    return [...tools.values()].map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters || { type: 'object', properties: {}, required: [] },
      },
    }));
  }

  /**
   * Get metadata for a tool (safety flags, limits).
   */
  function getToolMeta(name) {
    return tools.get(name) || null;
  }

  /**
   * Check if a tool call needs user confirmation.
   * @param {string} name
   * @param {object} args
   * @returns {boolean}
   */
  function needsConfirmation(name, args) {
    const meta = tools.get(name);
    if (!meta) return true; // unknown tool → require confirmation

    if (!meta.requiresConfirmation) return false;

    // Check safe patterns (e.g. exec_shell with ls/cat/df)
    if (meta.safePatterns.length > 0 && args) {
      const cmd = args.cmd || args.command || '';
      if (meta.safePatterns.some(p => p.test(cmd))) return false;
    }

    return true;
  }

  /**
   * Generate human-readable description of a tool action (for confirm dialog).
   */
  function describeAction(name, args) {
    const meta = tools.get(name);
    if (!meta) return `执行未知工具: ${name}`;

    switch (name) {
      case 'exec_shell':
        return `执行命令: ${args.cmd || '(empty)'}`;
      case 'write_file':
        return `写入文件: ${args.path || '(unknown)'}`;
      case 'open_trade':
        return `开仓: ${args.symbol} ${args.side} ${args.leverage || 10}x`;
      case 'close_trade':
        return `平仓: ${args.symbol || args.trade_id || '(unknown)'}`;
      case 'pause_trading':
        return '暂停自动交易';
      case 'resume_trading':
        return '恢复自动交易';
      case 'pm2_action':
        return `PM2 ${args.action}: ${args.name || 'all'}`;
      default:
        return `${meta.description}: ${JSON.stringify(args).slice(0, 100)}`;
    }
  }

  return { register, registerAll, getToolDefs, getToolMeta, needsConfirmation, describeAction };
}
