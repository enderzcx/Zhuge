/**
 * Telegram streaming editMessage — buffer text and flush every INTERVAL.
 * Features: typing indicator, MarkdownV2, long message splitting, tool status.
 *
 * Usage:
 *   const stream = createTGStream(chatId, tgCall);
 *   await stream.init();
 *   stream.append('hello ');
 *   await stream.finalize();
 */

const EDIT_INTERVAL = 600;   // ms between edits (TG rate limit ~30 edits/min)
const MAX_MSG_LEN = 4000;    // TG limit ~4096, leave room for markdown
const TYPING_INTERVAL = 4000; // TG typing indicator expires after 5s

export function createTGStream(chatId, tgCall) {
  let messageId = null;
  let buffer = '';
  let lastFlushed = '';
  let timer = null;
  let typingTimer = null;
  let flushing = false;
  let toolStatuses = [];       // [{ name, status }]
  let messageCount = 0;        // for long message splitting

  // --- Typing indicator ---

  function startTyping() {
    _sendTyping();
    if (!typingTimer) {
      typingTimer = setInterval(_sendTyping, TYPING_INTERVAL);
    }
  }

  function stopTyping() {
    if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
  }

  function _sendTyping() {
    tgCall('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  }

  // --- MarkdownV2 escaping ---

  function escapeMarkdown(text) {
    // Escape special chars for MarkdownV2, but preserve intentional formatting
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
  }

  /**
   * Format final text with MarkdownV2.
   * - Code blocks preserved (``` ... ```)
   * - Tool statuses get icons
   * - Plain text escaped
   */
  function formatOutput(text) {
    if (!text) return '\\.\\.\\.';

    // Split by code blocks, escape non-code parts
    const parts = text.split(/(```[\s\S]*?```)/);
    const formatted = parts.map(part => {
      if (part.startsWith('```')) return part; // code blocks as-is
      return escapeMarkdown(part);
    }).join('');

    return formatted || '\\.\\.\\.';
  }

  // --- Core streaming ---

  /**
   * Send initial message + start typing indicator.
   */
  async function init() {
    startTyping();
    try {
      const res = await tgCall('sendMessage', {
        chat_id: chatId,
        text: '⏳',
      });
      messageId = res?.result?.message_id;
      messageCount = 1;
    } catch {}
    return messageId;
  }

  /**
   * Append text to buffer. Schedules auto-flush.
   */
  function append(text) {
    buffer += text;
    if (!timer) {
      timer = setTimeout(() => { timer = null; _flush(); }, EDIT_INTERVAL);
    }
  }

  /**
   * Build display text: content + tool status footer.
   */
  function _buildDisplay() {
    let display = buffer || '';

    // Append tool status footer
    if (toolStatuses.length > 0) {
      const statusLines = toolStatuses.map(t => {
        if (t.status === 'running') return `⏳ ${t.name}...`;
        if (t.status === 'done') return `✅ ${t.name}`;
        if (t.status === 'error') return `❌ ${t.name}`;
        return `📋 ${t.name}`;
      });
      display = display ? display + '\n\n' + statusLines.join('\n') : statusLines.join('\n');
    }

    return display;
  }

  /**
   * Flush buffer to TG via editMessageText.
   */
  async function _flush() {
    if (flushing || !messageId) return;

    const display = _buildDisplay();
    if (display === lastFlushed) return;
    flushing = true;

    // Handle long messages: if over limit, send new message
    if (display.length > MAX_MSG_LEN) {
      await _splitAndSend(display);
      flushing = false;
      return;
    }

    try {
      await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: display || '⏳',
      });
      lastFlushed = display;
    } catch (err) {
      if (!err.message?.includes('not modified')) {
        messageId = null;
      }
    }
    flushing = false;
  }

  /**
   * Handle messages exceeding TG limit: finalize current, send new.
   */
  async function _splitAndSend(display) {
    // Finalize current message with first MAX_MSG_LEN chars
    const firstPart = display.slice(0, MAX_MSG_LEN - 10) + '\n\n⬇️';
    try {
      await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: firstPart,
      });
    } catch {}

    // Send continuation as new message
    const rest = display.slice(MAX_MSG_LEN - 10);
    try {
      const res = await tgCall('sendMessage', {
        chat_id: chatId,
        text: rest || '...',
      });
      messageId = res?.result?.message_id;
      messageCount++;
      lastFlushed = rest;
    } catch {}
  }

  /**
   * Set tool execution status (shown as footer).
   */
  function setToolStatus(toolName, status) {
    const existing = toolStatuses.find(t => t.name === toolName);
    if (existing) {
      existing.status = status;
    } else {
      toolStatuses.push({ name: toolName, status });
    }
    // Force a flush to show status immediately
    if (!timer) {
      timer = setTimeout(() => { timer = null; _flush(); }, 100); // faster flush for tool status
    }
  }

  /**
   * Final flush — clear timers, send final text.
   */
  async function finalize(finalText) {
    if (timer) { clearTimeout(timer); timer = null; }
    stopTyping();

    if (finalText !== undefined) buffer = finalText;
    toolStatuses = toolStatuses.filter(t => t.status !== 'done'); // keep only errors

    if (messageId) {
      lastFlushed = ''; // force flush
      await _flush();
    }
  }

  return {
    init, append, finalize, setToolStatus,
    flush: _flush,
    getMessageId: () => messageId,
    getMessageCount: () => messageCount,
  };
}
