/**
 * Conversation history manager — 3-layer context compression + SQLite persistence.
 *
 * Layer 1: Tool Result Budgeting — truncate single tool output > MAX_TOOL_CHARS
 * Layer 2: Sliding Window — keep last WINDOW_SIZE turns
 * Layer 3: Auto-Summarize — when exceeding window, compress old turns via LLM
 *
 * Persistence: each message written to conversation_history table.
 * On startup, restore() rebuilds in-memory Map from DB (within TTL).
 */

const WINDOW_SIZE = 20;       // max turns before compression
const KEEP_RECENT = 5;        // turns to keep after compression
const MAX_TOOL_CHARS = 2000;  // truncate tool results beyond this
const HISTORY_TTL = 60 * 60 * 1000; // 1h conversation timeout
const MAX_CONVERSATIONS = 50; // prevent memory leak

export function createHistory({ llm, db } = {}) {
  const store = new Map();
  const _db = db?.db || db || null;

  // Prepared statements (only if DB available)
  const stmtInsert = _db?.prepare?.(`
    INSERT INTO conversation_history (conversation_id, role, content, tool_calls, tool_call_id)
    VALUES (?, ?, ?, ?, ?)
  `) || null;
  const stmtLoadRecent = _db?.prepare?.(`
    SELECT conversation_id, role, content, tool_calls, tool_call_id, created_at
    FROM conversation_history
    WHERE created_at > datetime('now', ?)
    ORDER BY id
  `) || null;
  const stmtPrune = _db?.prepare?.(`
    DELETE FROM conversation_history WHERE created_at < datetime('now', ?)
  `) || null;

  /** Persist a message to DB (fire-and-forget). */
  const _persistBatch = _db?.transaction?.((conversationId, msgs) => {
    for (const msg of msgs) {
      stmtInsert.run(
        conversationId, msg.role, msg.content || null,
        msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
        msg.tool_call_id || null
      );
    }
  }) || null;

  function _persist(conversationId, msg) {
    if (!stmtInsert) return;
    try {
      stmtInsert.run(
        conversationId, msg.role, msg.content || null,
        msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
        msg.tool_call_id || null
      );
    } catch (e) { console.warn('[history] persist failed:', e.message); }
  }

  /**
   * Restore conversations from DB (called once on startup).
   * Rebuilds in-memory Map from messages within TTL.
   */
  function restore() {
    if (!stmtLoadRecent) return 0;
    try {
      const ttlStr = `-${Math.round(HISTORY_TTL / 1000)} seconds`;
      const rows = stmtLoadRecent.all(ttlStr);
      let restored = 0;

      for (const row of rows) {
        let conv = store.get(row.conversation_id);
        if (!conv) {
          conv = { messages: [], lastActive: new Date(row.created_at + 'Z').getTime(), summary: null };
          store.set(row.conversation_id, conv);
          restored++;
        }
        const msg = { role: row.role };
        if (row.content) msg.content = row.content;
        if (row.tool_calls) {
          try { msg.tool_calls = JSON.parse(row.tool_calls); } catch {
            console.warn('[history] corrupt tool_calls JSON, row id:', row.id);
            msg.content = '[tool_calls data corrupted]';
          }
        }
        if (row.tool_call_id) msg.tool_call_id = row.tool_call_id;
        conv.messages.push(msg);
        conv.lastActive = Math.max(conv.lastActive, new Date(row.created_at + 'Z').getTime());
      }
      return restored;
    } catch (e) {
      console.error('[history] restore failed:', e.message);
      return 0;
    }
  }

  function _get(conversationId) {
    let conv = store.get(conversationId);
    if (!conv) {
      conv = { messages: [], lastActive: Date.now(), summary: null };
      store.set(conversationId, conv);
    }
    conv.lastActive = Date.now();
    return conv;
  }

  function budgetToolResult(content) {
    if (typeof content !== 'string') content = JSON.stringify(content);
    if (content.length <= MAX_TOOL_CHARS) return content;
    return content.slice(0, MAX_TOOL_CHARS) + `\n...[truncated ${content.length - MAX_TOOL_CHARS} chars]`;
  }

  function add(conversationId, msg) {
    const conv = _get(conversationId);
    if (msg.role === 'tool' && msg.content) {
      msg = { ...msg, content: budgetToolResult(msg.content) };
    }
    conv.messages.push(msg);
    _persist(conversationId, msg);
  }

  function addAssistant(conversationId, message) {
    const conv = _get(conversationId);
    conv.messages.push(message);
    _persist(conversationId, message);
  }

  async function getMessages(conversationId) {
    const conv = _get(conversationId);
    const msgs = conv.messages;
    const turns = msgs.filter(m => m.role === 'user').length;
    if (turns > WINDOW_SIZE) await _compress(conv);
    return _sanitizeMessages([...conv.messages]);
  }

  /**
   * Sanitize messages before sending to LLM:
   * - Remove dangling tool_calls without matching tool responses
   * - Remove orphan tool responses without matching assistant tool_calls
   * - Ensure no user message follows an assistant tool_call without tool response in between
   * This prevents 400 errors from the LLM API.
   */
  function _sanitizeMessages(msgs) {
    // Collect all tool_call ids that have a matching tool response
    const toolResponseIds = new Set();
    for (const m of msgs) {
      if (m.role === 'tool' && m.tool_call_id) toolResponseIds.add(m.tool_call_id);
    }

    // Filter: remove assistant tool_calls without matching tool responses
    const sanitized = [];
    for (const m of msgs) {
      if (m.role === 'assistant' && m.tool_calls?.length > 0) {
        // Check if ALL tool_calls have matching responses
        const allMatched = m.tool_calls.every(tc => toolResponseIds.has(tc.id));
        if (!allMatched) {
          // Drop the entire assistant message with dangling tool_calls
          // (keeping it would cause LLM 400 because tool response is missing)
          continue;
        }
      }
      if (m.role === 'tool' && m.tool_call_id) {
        // Check if there's a matching assistant tool_call before this
        const hasMatch = sanitized.some(prev =>
          prev.role === 'assistant' && prev.tool_calls?.some(tc => tc.id === m.tool_call_id)
        );
        if (!hasMatch) continue; // orphan tool response
      }
      sanitized.push(m);
    }
    return sanitized;
  }

  async function _compress(conv) {
    const msgs = conv.messages;
    let keepFrom = msgs.length;
    let usersSeen = 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        usersSeen++;
        if (usersSeen >= KEEP_RECENT) { keepFrom = i; break; }
      }
    }
    while (keepFrom > 0 && msgs[keepFrom].role === 'tool') keepFrom--;

    const oldMessages = msgs.slice(0, keepFrom);
    const recentMessages = msgs.slice(keepFrom);
    if (oldMessages.length === 0) return;

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
        summary = `[前 ${oldMessages.length} 条消息已压缩]`;
      }
    } else {
      summary = `[前 ${oldMessages.length} 条消息已压缩]`;
    }

    conv.summary = summary;
    conv.messages = [
      { role: 'user', content: `[对话摘要] ${summary}` },
      { role: 'assistant', content: '好的，我已了解之前的对话内容。' },
      ...recentMessages,
    ];
  }

  function turnCount(conversationId) {
    const conv = store.get(conversationId);
    if (!conv) return 0;
    return conv.messages.filter(m => m.role === 'user').length;
  }

  function clear(conversationId) {
    store.delete(conversationId);
  }

  function prune() {
    const cutoff = Date.now() - HISTORY_TTL;
    for (const [id, conv] of store) {
      if (conv.lastActive < cutoff) store.delete(id);
    }
    if (store.size > MAX_CONVERSATIONS) {
      const sorted = [...store.entries()].sort((a, b) => a[1].lastActive - b[1].lastActive);
      const toRemove = sorted.slice(0, store.size - MAX_CONVERSATIONS);
      for (const [id] of toRemove) store.delete(id);
    }
    // DB cleanup: remove messages older than TTL
    if (stmtPrune) {
      try { stmtPrune.run(`-${Math.round(HISTORY_TTL / 1000)} seconds`); } catch {}
    }
  }

  const pruneTimer = setInterval(prune, 10 * 60 * 1000);
  function stop() { clearInterval(pruneTimer); }

  return { add, addAssistant, getMessages, turnCount, clear, prune, stop, budgetToolResult, restore };
}
