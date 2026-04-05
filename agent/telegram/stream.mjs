/**
 * Telegram streaming editMessage — buffer text and flush every INTERVAL.
 *
 * Usage:
 *   const stream = createTGStream(chatId, tgCall);
 *   stream.append('hello ');
 *   stream.append('world');
 *   await stream.flush();       // force flush
 *   await stream.finalize();    // final flush + cleanup
 */

const EDIT_INTERVAL = 500; // ms between edits
const MAX_MSG_LEN = 4000;  // TG message limit ~4096, leave buffer

export function createTGStream(chatId, tgCall) {
  let messageId = null;
  let buffer = '';
  let lastFlushed = '';
  let timer = null;
  let flushing = false;

  /**
   * Send initial empty message to get messageId for edits.
   */
  async function init() {
    try {
      const res = await tgCall('sendMessage', { chat_id: chatId, text: '...' });
      messageId = res?.result?.message_id;
    } catch {}
    return messageId;
  }

  /**
   * Append text to buffer. Schedules auto-flush.
   */
  function append(text) {
    buffer += text;
    if (!timer) {
      timer = setTimeout(() => { timer = null; flush(); }, EDIT_INTERVAL);
    }
  }

  /**
   * Flush buffer to TG via editMessageText.
   */
  async function flush() {
    if (flushing || !messageId) return;
    if (buffer === lastFlushed) return;
    flushing = true;

    const text = buffer.length > MAX_MSG_LEN
      ? '...' + buffer.slice(-MAX_MSG_LEN + 3)
      : buffer;

    try {
      await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: text || '...',
      });
      lastFlushed = buffer;
    } catch (err) {
      // TG 400 "message is not modified" is OK — text didn't change
      if (!err.message?.includes('not modified')) {
        // If message was deleted or other error, stop streaming
        messageId = null;
      }
    }
    flushing = false;
  }

  /**
   * Final flush — clear timer, flush remaining buffer.
   */
  async function finalize(finalText) {
    if (timer) { clearTimeout(timer); timer = null; }
    if (finalText !== undefined) buffer = finalText;
    if (buffer && messageId) {
      lastFlushed = ''; // force flush
      await flush();
    }
  }

  /**
   * Replace buffer with tool status indicator.
   */
  function setToolStatus(toolName, status) {
    const indicator = status === 'running' ? `🔧 ${toolName}...` : `✅ ${toolName}`;
    if (buffer) {
      buffer += `\n${indicator}`;
    } else {
      buffer = indicator;
    }
    flush();
  }

  return { init, append, flush, finalize, setToolStatus, getMessageId: () => messageId };
}
