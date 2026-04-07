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

import { checkSkillWorthy } from './cognition/skill-check.mjs';
import { saveRecallableMemory } from './memory/recall.mjs';

const MAX_ROUNDS = 8;
const SELF_CHECK_INTERVAL = 15; // self-inspect every N tool calls

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

    // 2. Add user message to history (skip if resuming after confirm — message already in history)
    if (userMessage != null && !deps.resumeAfterConfirm) {
      history.add(conversationId, { role: 'user', content: userMessage });
    }

    // 3. Build system prompt (static + dynamic: compound rules, directives, state)
    const systemPrompt = await buildSystemPrompt({ conversationId, userMessage });

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
          // Break immediately — don't execute remaining tool calls out of order.
          // The confirm handler will resume the loop after user responds.
          break;
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

      // Self-inspection: every SELF_CHECK_INTERVAL tool calls, nudge agent to reflect
      if (allToolCalls.length > 0 && allToolCalls.length % SELF_CHECK_INTERVAL === 0) {
        history.add(conversationId, {
          role: 'system',
          content: '自检时间：回顾你刚才的操作，哪些做对了？哪些可以改进？有什么需要记住的新经验？如果有，用 save_recallable_memory 保存。',
        });
      }

      // If any tool needs confirmation, pause the loop.
      // The confirm handler will resume by adding tool results and re-calling agentLoop.
      if (hasConfirmPending) break;

      // Continue loop — LLM will process tool results
    }

    // Memory checkpoint: force context.md update if not done this conversation
    // Must specifically check for context.md write — saving directives or notes doesn't count
    const savedContext = allToolCalls.some(tc =>
      tc.name === 'save_memory' && tc.args?.file === 'context.md'
    );
    if (!savedContext && rounds < MAX_ROUNDS && finalContent) {
      _log.info('memory_checkpoint', { module: 'agent-loop', conversationId, msg: 'no save_memory called, nudging' });
      history.add(conversationId, {
        role: 'user',
        content: '[system] 对话即将结束。请调用 save_memory 更新 context.md（当前状态/结论/未完成事项）。这是强制要求。',
      });
      const nudgeMessages = await history.getMessages(conversationId);
      const nudgeFull = [{ role: 'system', content: await buildSystemPrompt({ conversationId, userMessage }) }, ...nudgeMessages];
      for await (const chunk of agentLLM.chatStream(nudgeFull, { model: modelSelector.select(conversationId, '', {}), tools: executor.getToolDefs() })) {
        if (chunk.done && chunk.tool_calls?.length > 0) {
          for (const tc of chunk.tool_calls) {
            const fnName = tc.function?.name;
            if (fnName === 'save_memory' || fnName === 'save_recallable_memory') {
              let args; try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = {}; }
              await executor.execute(fnName, args);
              allToolCalls.push({ name: fnName, args, result: 'auto', duration_ms: 0 });
              _log.info('memory_auto_saved', { module: 'agent-loop', tool: fnName });
            }
          }
        }
      }
    }

    // Skill distillation: if 5+ tool calls, check if worth saving as reusable knowledge
    if (allToolCalls.length >= 5 && !deps.resumeAfterConfirm) {
      try {
        const skill = await checkSkillWorthy(allToolCalls, finalContent, { agentLLM });
        if (skill) {
          saveRecallableMemory({
            name: skill.title,
            description: skill.description,
            type: 'feedback',
            content: skill.content,
          });
          _log.info('skill_created', { module: 'agent-loop', title: skill.title, tools: allToolCalls.length });
        }
      } catch {} // never block main flow
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
