/**
 * Model selection with latch — pick once per conversation, don't switch.
 *
 * Strategy:
 *   gpt-5.4-mini (default): simple queries, single tool calls, quick commands
 *   gpt-5.4 (upgrade): analysis keywords, multi-tool, deep reasoning, user request
 *
 * Latch: once selected for a conversation, locked until conversation ends.
 */

const UPGRADE_KEYWORDS = [
  '分析', '研究', '为什么', '原因', '对比', '比较', '评估', '策略',
  'analyze', 'research', 'why', 'compare', 'evaluate', 'strategy',
  '深度', '详细', '复盘', '回顾', 'compound', '认知',
];

const MINI_MODEL = 'gpt-5.4-mini';
const FULL_MODEL = 'gpt-5.4';

export function createModelSelector(config) {
  // Latch state per conversation
  const latches = new Map(); // conversationId → model
  const LATCH_TTL = 30 * 60 * 1000; // 30 min conversation timeout

  /**
   * Select model for a conversation turn.
   * @param {string} conversationId - unique conversation identifier (e.g. TG chat_id + thread)
   * @param {string} userMessage - current user message
   * @param {{ toolCallCount?: number, turnCount?: number, forceModel?: string }} ctx
   * @returns {string} model name
   */
  function select(conversationId, userMessage, ctx = {}) {
    // Force model override (user explicitly requested)
    if (ctx.forceModel) {
      latches.set(conversationId, { model: ctx.forceModel, ts: Date.now() });
      return ctx.forceModel;
    }

    // Check latch — if already selected for this conversation, keep it
    const latch = latches.get(conversationId);
    if (latch && (Date.now() - latch.ts) < LATCH_TTL) {
      return latch.model;
    }

    // Select based on signals
    let model = MINI_MODEL;
    const msg = (userMessage || '').toLowerCase();

    // Upgrade conditions
    const hasKeyword = UPGRADE_KEYWORDS.some(kw => msg.includes(kw));
    const isLong = msg.length > 200;
    const manyTools = (ctx.toolCallCount || 0) > 3;
    const deepConversation = (ctx.turnCount || 0) > 5;

    if (hasKeyword || isLong || manyTools || deepConversation) {
      model = FULL_MODEL;
    }

    // Latch the selection
    latches.set(conversationId, { model, ts: Date.now() });

    // Prune old latches (prevent memory leak)
    if (latches.size > 100) {
      const cutoff = Date.now() - LATCH_TTL;
      for (const [id, v] of latches) {
        if (v.ts < cutoff) latches.delete(id);
      }
    }

    return model;
  }

  /**
   * Clear latch for a conversation (e.g. on explicit reset).
   */
  function reset(conversationId) {
    latches.delete(conversationId);
  }

  return { select, reset };
}
