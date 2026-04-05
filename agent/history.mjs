/**
 * Conversation history manager — 3-layer context compression.
 *
 * Layer 1: Tool Result Budgeting — truncate single tool output > MAX_TOOL_CHARS
 * Layer 2: Sliding Window — keep last WINDOW_SIZE turns
 * Layer 3: Auto-Summarize — when exceeding window, compress old turns via LLM
 *
 * Storage: in-memory Map keyed by conversationId, with TTL cleanup.
 */

const WINDOW_SIZE = 20;       // max turns before compression
const KEEP_RECENT = 5;        // turns to keep after compression
const MAX_TOOL_CHARS = 2000;  // truncate tool results beyond this
const HISTORY_TTL = 60 * 60 * 1000; // 1h conversation timeout
const MAX_CONVERSATIONS = 50; // prevent memory leak

export function createHistory({ llm } = {}) {
  // conversationId → { messages: [], lastActive: timestamp, summary: string|null }
  const store = new Map();

  /**
   * Get or create conversation history.
   */
  function _get(conversationId) {
    let conv = store.get(conversationId);
    if (!conv) {
      conv = { messages: [], lastActive: Date.now(), summary: null };
      store.set(conversationId, conv);
    }
    conv.lastActive = Date.now();
    return conv;
  }

  /**
   * Layer 1: Budget tool result content.
   */
  function budgetToolResult(content) {
    if (typeof content !== 'string') content = JSON.stringify(content);
    if (content.length <= MAX_TOOL_CHARS) return content;
    return content.slice(0, MAX_TOOL_CHARS) + `\n...[truncated ${content.length - MAX_TOOL_CHARS} chars]`;
  }

  /**
   * Add a message to conversation history.
   * @param {string} conversationId
   * @param {{ role: string, content?: string, tool_calls?: any[], tool_call_id?: string }} msg
   */
  function add(conversationId, msg) {
    const conv = _get(conversationId);

    // Layer 1: budget tool results
    if (msg.role === 'tool' && msg.content) {
      msg = { ...msg, content: budgetToolResult(msg.content) };
    }

    conv.messages.push(msg);
  }

  /**
   * Add the full assistant message (may contain tool_calls).
   */
  function addAssistant(conversationId, message) {
    const conv = _get(conversationId);
    conv.messages.push(message);
  }

  /**
   * Get messages for LLM call. Applies Layer 2 + 3 if needed.
   * @param {string} conversationId
   * @returns {object[]} messages array (without system prompt — caller adds that)
   */
  async function getMessages(conversationId) {
    const conv = _get(conversationId);
    const msgs = conv.messages;

    // Count user messages as turns (consistent with exported turnCount())
    const turns = msgs.filter(m => m.role === 'user').length;

    if (turns <= WINDOW_SIZE) {
      return [...msgs];
    }

    // Layer 3: compress old messages
    await _compress(conv);
    return [...msgs];
  }

  /**
   * Layer 3: Auto-summarize old turns.
   * Keep last KEEP_RECENT user turns (+ their tool chains), compress the rest.
   * Split is tool-call-boundary-aware: never splits between assistant(tool_calls) and tool results.
   */
  async function _compress(conv) {
    const msgs = conv.messages;

    // Find the split point: keep last KEEP_RECENT user messages.
    // Walk backwards, count user messages. The split point must be at a "safe"
    // boundary: before a user message, never between assistant(tool_calls) and tool results.
    let keepFrom = msgs.length;
    let usersSeen = 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        usersSeen++;
        if (usersSeen >= KEEP_RECENT) {
          keepFrom = i;
          break;
        }
      }
    }

    // Ensure we don't split inside a tool_call→tool sequence.
    // Walk keepFrom backwards to find a safe boundary (a user message start).
    while (keepFrom > 0 && msgs[keepFrom].role === 'tool') {
      keepFrom--;
    }

    const oldMessages = msgs.slice(0, keepFrom);
    const recentMessages = msgs.slice(keepFrom);

    if (oldMessages.length === 0) return;

    // Summarize old messages
    let summary;
    if (llm) {
      try {
        const summaryPrompt = [
          { role: 'system', content: 'Summarize the following conversation in 3-5 bullet points. Focus on: decisions made, information retrieved, user preferences expressed. Output in Chinese.' },
          { role: 'user', content: oldMessages.map(m => `[${m.role}] ${m.content || '(tool_call)'}`.slice(0, 200)).join('\n') },
        ];
        const result = await llm(summaryPrompt, { max_tokens: 300, timeout: 15000 });
        summary = result.content || result;
      } catch {
        // Fallback: mechanical summary
        summary = `[前 ${oldMessages.length} 条消息已压缩]`;
      }
    } else {
      summary = `[前 ${oldMessages.length} 条消息已压缩]`;
    }

    conv.summary = summary;
    // Replace messages: summary as first user message + recent
    conv.messages = [
      { role: 'user', content: `[对话摘要] ${summary}` },
      { role: 'assistant', content: '好的，我已了解之前的对话内容。' },
      ...recentMessages,
    ];
  }

  /**
   * Get turn count for a conversation.
   */
  function turnCount(conversationId) {
    const conv = store.get(conversationId);
    if (!conv) return 0;
    return conv.messages.filter(m => m.role === 'user').length;
  }

  /**
   * Clear a conversation.
   */
  function clear(conversationId) {
    store.delete(conversationId);
  }

  /**
   * Prune expired conversations.
   */
  function prune() {
    const cutoff = Date.now() - HISTORY_TTL;
    for (const [id, conv] of store) {
      if (conv.lastActive < cutoff) store.delete(id);
    }
    // Hard cap
    if (store.size > MAX_CONVERSATIONS) {
      const sorted = [...store.entries()].sort((a, b) => a[1].lastActive - b[1].lastActive);
      const toRemove = sorted.slice(0, store.size - MAX_CONVERSATIONS);
      for (const [id] of toRemove) store.delete(id);
    }
  }

  // Auto-prune every 10 minutes
  const pruneTimer = setInterval(prune, 10 * 60 * 1000);

  function stop() { clearInterval(pruneTimer); }

  return { add, addAssistant, getMessages, turnCount, clear, prune, stop, budgetToolResult };
}
