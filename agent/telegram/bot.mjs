/**
 * Telegram bot — long-polling + message routing + agent loop integration.
 *
 * Consumes events from agentLoop generator and routes them to:
 *   - stream.mjs for text streaming
 *   - confirm.mjs for dangerous operation confirmations
 *   - metrics for observability
 */

const POLL_TIMEOUT = 25;     // seconds
const POLL_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 30000;

export function createAgentBot({ config, agentLLM, history, executor, modelSelector, buildSystemPrompt, confirmHandler, log, metrics }) {
  const _log = log || { info() {}, warn() {}, error() {} };
  const _m = metrics || { record() {} };

  const botToken = config.SP_BOT_TOKEN || config.TG_BOT_TOKEN;
  const allowedChatId = config.TG_CHAT_ID;
  let pollOffset = 0;
  let running = false;

  /**
   * Generic TG Bot API call.
   */
  async function tgCall(method, body = {}) {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(method === 'getUpdates' ? (POLL_TIMEOUT + 5) * 1000 : 10000),
    });
    if (!res.ok) throw new Error(`TG ${method} ${res.status}`);
    return res.json();
  }

  /**
   * Send a simple text message.
   */
  async function sendMessage(chatId, text, opts = {}) {
    return tgCall('sendMessage', { chat_id: chatId, text: text.slice(0, 4000), ...opts });
  }

  /**
   * Handle a user message — run agent loop, stream response.
   */
  async function handleMessage(chatId, text, messageId) {
    const { createTGStream } = await import('./stream.mjs');
    const { agentLoop } = await import('../loop.mjs');

    const conversationId = String(chatId);
    const stream = createTGStream(chatId, tgCall);
    await stream.init();

    _m.record('tg_msg_received', 1);
    const replyStart = Date.now();

    try {
      const loop = agentLoop(conversationId, text, {
        agentLLM, history, executor, modelSelector, buildSystemPrompt, log: _log, metrics: _m,
      });

      for await (const event of loop) {
        switch (event.type) {
          case 'text':
            stream.append(event.text);
            break;

          case 'tool_start':
            stream.setToolStatus(event.name, 'running');
            break;

          case 'tool_result':
            stream.setToolStatus(event.name, 'done');
            break;

          case 'confirm_needed': {
            // Flush current stream
            await stream.finalize();
            // Request confirmation (blocks until user responds or timeout)
            const { confirmed, result } = await confirmHandler.requestConfirm(chatId, event);
            if (confirmed) {
              // Tool was executed by confirm handler, continue loop
              // The loop will re-call LLM with the tool result
            }
            // Re-init stream for continued output
            await stream.init();
            break;
          }

          case 'done':
            await stream.finalize(event.content);
            _m.record('tg_reply_latency_ms', Date.now() - replyStart);
            break;

          case 'error':
            await stream.finalize(`Error: ${event.error}`);
            _m.record('error_count', 1, { module: 'tg-bot', type: 'agent_error' });
            break;
        }
      }
    } catch (err) {
      _log.error('handle_message_error', { module: 'tg-bot', error: err.message });
      await stream.finalize(`Error: ${err.message}`);
    }
  }

  /**
   * Process a single TG update.
   */
  async function processUpdate(update) {
    // Callback query (inline keyboard)
    if (update.callback_query) {
      if (confirmHandler.isOurCallback(update.callback_query.data)) {
        await confirmHandler.handleCallback(update.callback_query);
      }
      return;
    }

    const msg = update.message;
    if (!msg?.text) return;

    const chatId = String(msg.chat.id);

    // Auth check
    if (allowedChatId && chatId !== String(allowedChatId)) {
      _log.warn('unauthorized_msg', { module: 'tg-bot', chatId });
      return;
    }

    // Handle message (don't await — process concurrently for responsiveness)
    handleMessage(chatId, msg.text, msg.message_id).catch(err => {
      _log.error('message_handler_crash', { module: 'tg-bot', error: err.message });
    });
  }

  /**
   * Long-polling loop.
   */
  async function startPolling() {
    if (running) return;
    running = true;
    let backoff = POLL_BACKOFF_MS;

    _log.info('tg_bot_started', { module: 'tg-bot' });

    while (running) {
      try {
        const data = await tgCall('getUpdates', {
          offset: pollOffset,
          timeout: POLL_TIMEOUT,
          allowed_updates: ['message', 'callback_query'],
        });

        const updates = data.result || [];
        for (const update of updates) {
          pollOffset = update.update_id + 1;
          processUpdate(update).catch(err => {
            _log.error('process_update_error', { module: 'tg-bot', error: err.message });
          });
        }

        backoff = POLL_BACKOFF_MS; // reset on success
      } catch (err) {
        _log.error('polling_error', { module: 'tg-bot', error: err.message });
        await new Promise(r => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  }

  function stop() { running = false; }

  return { startPolling, stop, tgCall, sendMessage };
}
