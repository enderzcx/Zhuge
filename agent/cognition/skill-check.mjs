/**
 * Hermes-style skill check: after complex tool interactions (5+),
 * evaluate whether the experience is worth distilling into a reusable note.
 *
 * Two-phase: fast heuristic filter (no LLM) → LLM quick eval (200 tokens).
 */

const WRITE_TOOLS = new Set([
  'save_memory', 'add_directive', 'save_recallable_memory',
  'open_trade', 'close_trade', 'pause_trading', 'resume_trading',
  'schedule_task', 'toggle_scheduled_task',
  'add_knowledge', 'run_compound', 'run_backtest',
  'exec_shell', 'write_file',
]);

const MIN_TOOL_CALLS = 5;

/**
 * Phase 1: Fast heuristic — should we even ask the LLM?
 * @param {Array} toolCalls - [{ name, args, result, duration_ms }]
 * @returns {boolean}
 */
function _passesHeuristic(toolCalls) {
  if (toolCalls.length < MIN_TOOL_CALLS) return false;

  // Need at least one successful result (not all errors)
  const hasSuccess = toolCalls.some(tc => {
    const r = typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result || '');
    return !r.includes('"error"') && !r.startsWith('Error:');
  });
  if (!hasSuccess) return false;

  // Need at least one "write" tool (not just read-only queries)
  const hasWrite = toolCalls.some(tc => WRITE_TOOLS.has(tc.name));
  if (!hasWrite) return false;

  return true;
}

/**
 * Phase 2: LLM quick evaluation — is this worth distilling?
 * @param {Array} toolCalls
 * @param {string} finalContent - what the agent said at the end
 * @param {object} deps - { agentLLM }
 * @returns {null | { title, description, content }}
 */
export async function checkSkillWorthy(toolCalls, finalContent, { agentLLM }) {
  if (!_passesHeuristic(toolCalls)) return null;
  if (!agentLLM?.chat) return null;

  // Sanitize tool results to prevent prompt injection into memory
  const _sanitize = (s) => s.replace(/[{}"]/g, '').replace(/\n/g, ' ').trim();
  const toolSummary = toolCalls.map(tc => {
    const result = typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result || '');
    return `<tool>${tc.name}</tool> → <result>${_sanitize(result.slice(0, 80))}</result>`;
  }).join('\n');

  try {
    const result = await agentLLM.chat([
      {
        role: 'system',
        content: `你是一个经验沉淀助手。判断以下操作序列是否有值得记录的经验。
如果有，输出 JSON: {"worthy": true, "title": "简短标题", "description": "一句话描述", "content": "详细步骤+关键发现+注意事项，100-300字"}
如果没有值得记录的，输出: {"worthy": false}
只输出 JSON，不要其他文字。`,
      },
      {
        role: 'user',
        content: `工具调用序列 (${toolCalls.length} 步):\n${toolSummary}\n\n最终回复摘要: ${(finalContent || '').slice(0, 200)}`,
      },
    ], { max_tokens: 300, timeout: 15000 });

    const text = (result.content || '').trim();
    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.worthy) return null;

    return {
      title: (parsed.title || '').slice(0, 60),
      description: (parsed.description || '').slice(0, 120),
      content: (parsed.content || '').slice(0, 500),
    };
  } catch {
    return null; // LLM failure should never block the main flow
  }
}
