/**
 * Telegram inline keyboard confirmation for dangerous operations.
 *
 * When a tool needs confirmation, sends an inline keyboard with approve/deny buttons.
 * Handles callback_query from TG, executes or skips the tool, then resumes the agent loop.
 */

const CONFIRM_TIMEOUT = 60000; // 1 min to confirm

export function createConfirmHandler({ tgCall: _initTgCall, executor, history, log }) {
  const _log = log || { info() {}, warn() {}, error() {} };
  let tgCall = _initTgCall;

  /**
   * Set tgCall after construction (resolves circular dep with bot.mjs).
   */
  function setTgCall(fn) { tgCall = fn; }

  // Pending confirmations: callbackId → { chatId, toolCallId, name, args, resolve, timer }
  const pending = new Map();

  /**
   * Request confirmation for a tool call.
   * @returns {Promise<{ confirmed: boolean, result?: string }>}
   */
  function requestConfirm(chatId, { name, args, description, toolCallId }) {
    return new Promise(async (resolve) => {
      const callbackId = `confirm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

      const text = `⚠️ 需要确认\n\n${description}\n\n参数: ${JSON.stringify(args).slice(0, 300)}`;

      try {
        const res = await tgCall('sendMessage', {
          chat_id: chatId,
          text,
          reply_markup: JSON.stringify({
            inline_keyboard: [[
              { text: '✅ 确认执行', callback_data: `${callbackId}:yes` },
              { text: '❌ 取消', callback_data: `${callbackId}:no` },
            ]],
          }),
        });

        const timer = setTimeout(() => {
          pending.delete(callbackId);
          resolve({ confirmed: false, result: '操作超时未确认，已取消' });
          // Edit message to show timeout
          tgCall('editMessageText', {
            chat_id: chatId,
            message_id: res?.result?.message_id,
            text: `⏰ 已超时: ${description}`,
          }).catch(() => {});
        }, CONFIRM_TIMEOUT);

        pending.set(callbackId, {
          chatId,
          toolCallId,
          name,
          args,
          messageId: res?.result?.message_id,
          resolve,
          timer,
        });
      } catch (err) {
        _log.error('confirm_send_failed', { module: 'confirm', error: err.message });
        resolve({ confirmed: false, result: `确认消息发送失败: ${err.message}` });
      }
    });
  }

  /**
   * Handle TG callback_query (user clicked confirm/cancel button).
   */
  async function handleCallback(callbackQuery) {
    const data = callbackQuery.data || '';
    const [callbackId, action] = data.split(':');

    const entry = pending.get(callbackId);
    if (!entry) {
      // Expired or unknown
      await tgCall('answerCallbackQuery', {
        callback_query_id: callbackQuery.id,
        text: '已过期',
      }).catch(() => {});
      return;
    }

    clearTimeout(entry.timer);
    pending.delete(callbackId);

    await tgCall('answerCallbackQuery', {
      callback_query_id: callbackQuery.id,
      text: action === 'yes' ? '执行中...' : '已取消',
    }).catch(() => {});

    if (action === 'yes') {
      // Execute the tool
      const result = await executor.execute(entry.name, entry.args);

      // Add real result to history
      history.add(entry.chatId, {
        role: 'tool',
        tool_call_id: entry.toolCallId,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });

      // Edit confirm message to show result
      await tgCall('editMessageText', {
        chat_id: entry.chatId,
        message_id: entry.messageId,
        text: `✅ ${entry.name}\n${(typeof result === 'string' ? result : JSON.stringify(result)).slice(0, 500)}`,
      }).catch(() => {});

      _log.info('confirm_approved', { module: 'confirm', tool: entry.name });
      entry.resolve({ confirmed: true, result });
    } else {
      // Add denial to history
      history.add(entry.chatId, {
        role: 'tool',
        tool_call_id: entry.toolCallId,
        content: '用户取消了此操作',
      });

      await tgCall('editMessageText', {
        chat_id: entry.chatId,
        message_id: entry.messageId,
        text: `❌ 已取消: ${executor.describeAction(entry.name, entry.args)}`,
      }).catch(() => {});

      _log.info('confirm_denied', { module: 'confirm', tool: entry.name });
      entry.resolve({ confirmed: false, result: '用户取消了此操作' });
    }
  }

  /**
   * Check if a callback_query belongs to us.
   */
  function isOurCallback(data) {
    return data?.startsWith('confirm_');
  }

  return { requestConfirm, handleCallback, isOurCallback, setTgCall };
}
