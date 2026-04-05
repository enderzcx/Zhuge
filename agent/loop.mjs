/**
 * Agent loop — async generator that drives the LLM + tool execution cycle.
 *
 * Yields events as the loop progresses:
 *   { type: 'text', text }           — streaming text chunk
 *   { type: 'tool_start', name, args } — about to execute a tool
 *   { type: 'tool_result', name, result, duration_ms }
 *   { type: 'confirm_needed', name, args, description } — needs user approval
 *   { type: 'done', content, toolCalls, tokens, rounds }
 *   { type: 'error', error }
 *
 * The caller (telegram/bot.mjs) consumes these events to:
 *   - Stream text to TG via editMessage
 *   - Show inline keyboard for confirmations
 *   - Record metrics
 */

const MAX_ROUNDS = 8;

/**
 * @param {object} deps
 * @param {object} deps.agentLLM - { chat, chatStream } from agent/llm.mjs
 * @param {object} deps.history - from agent/history.mjs
 * @param {object} deps.executor - from agent/tools/executor.mjs
 * @param {object} deps.modelSelector - from agent/model-select.mjs
 * @param {Function} deps.buildSystemPrompt - from agent/prompts/loader.mjs
 * @param {object} [deps.log]
 * @param {object} [deps.metrics]
 */
export async function* agentLoop(conversationId, userMessage, deps) {
  const { agentLLM, history, executor, modelSelector, buildSystemPrompt, log, metrics } = deps;
  const _log = log || { info() {}, warn() {}, error() {} };
  const _m = metrics || { record() {} };
  const loopStart = Date.now();

  let totalTokens = { input: 0, output: 0, total: 0 };
  let allToolCalls = [];
  let rounds = 0;
  let finalContent = '';

  try {
    // 1. Select model (latched per conversation)
    const model = modelSelector.select(conversationId, userMessage, {
      turnCount: history.turnCount(conversationId),
    });

    // 2. Add user message to history
    history.add(conversationId, { role: 'user', content: userMessage });

    // 3. Build system prompt (static + dynamic: compound rules, directives, state)
    const systemPrompt = await buildSystemPrompt();

    for (rounds = 0; rounds < MAX_ROUNDS; rounds++) {
      // 4. Get conversation messages
      const messages = await history.getMessages(conversationId);
      const fullMessages = [{ role: 'system', content: systemPrompt }, ...messages];

      // 5. Get tool definitions from executor
      const tools = executor.getToolDefs();

      // 6. Call LLM (streaming)
      let result;
      for await (const chunk of agentLLM.chatStream(fullMessages, { model, tools })) {
        if (chunk.text) {
          yield { type: 'text', text: chunk.text };
        }
        if (chunk.done) {
          result = chunk;
        }
      }

      if (!result) {
        yield { type: 'error', error: 'No LLM response' };
        return;
      }

      // Accumulate tokens
      totalTokens.input += result.tokens?.input || 0;
      totalTokens.output += result.tokens?.output || 0;
      totalTokens.total += result.tokens?.total || 0;

      // Add assistant message to history
      history.addAssistant(conversationId, result.message);

      // 7. No tool calls → done
      if (!result.tool_calls || result.tool_calls.length === 0) {
        finalContent = result.content;
        break;
      }

      // Track last assistant content in case we hit MAX_ROUNDS
      finalContent = result.content || finalContent;

      // 8. Execute tool calls
      let hasConfirmPending = false;
      for (const tc of result.tool_calls) {
        const fnName = tc.function?.name;
        let args;
        try {
          args = JSON.parse(tc.function?.arguments || '{}');
        } catch {
          args = {};
          _log.warn('tool_args_parse_failed', { module: 'agent-loop', tool: fnName });
        }

        // Check if tool needs confirmation
        const needsConfirm = executor.needsConfirmation(fnName, args);
        if (needsConfirm) {
          hasConfirmPending = true;
          yield {
            type: 'confirm_needed',
            name: fnName,
            args,
            description: executor.describeAction(fnName, args),
            toolCallId: tc.id,
          };
          // Don't add placeholder to history — the confirm handler will
          // execute the tool and add the real result when user confirms/denies.
          // The loop will exit after this iteration; confirm handler re-invokes
          // the loop with the updated history.
          continue;
        }

        yield { type: 'tool_start', name: fnName, args };

        const toolStart = Date.now();
        const toolResult = await executor.execute(fnName, args);
        const toolDuration = Date.now() - toolStart;

        _m.record('tool_latency_ms', toolDuration, { tool: fnName, success: !toolResult.error });

        allToolCalls.push({ name: fnName, args, result: toolResult, duration_ms: toolDuration });

        yield { type: 'tool_result', name: fnName, result: toolResult, duration_ms: toolDuration };

        // Add tool result to history (budgeted)
        history.add(conversationId, {
          role: 'tool',
          tool_call_id: tc.id,
          content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
        });
      }

      // If any tool needs confirmation, pause the loop.
      // The confirm handler will resume by adding tool results and re-calling agentLoop.
      if (hasConfirmPending) break;

      // Continue loop — LLM will process tool results
    }

    // Done
    const totalDuration = Date.now() - loopStart;
    _m.record('agent_loop_ms', totalDuration, { rounds, tools: allToolCalls.length });
    _log.info('agent_loop_done', {
      module: 'agent-loop',
      conversationId,
      rounds,
      tools: allToolCalls.length,
      duration_ms: totalDuration,
      tokens: totalTokens.total,
    });

    yield {
      type: 'done',
      content: finalContent,
      toolCalls: allToolCalls,
      tokens: totalTokens,
      rounds,
      duration_ms: totalDuration,
    };
  } catch (err) {
    _m.record('error_count', 1, { module: 'agent-loop', type: 'loop' });
    _log.error('agent_loop_error', { module: 'agent-loop', conversationId, error: err.message });
    yield { type: 'error', error: err.message };
  }
}
