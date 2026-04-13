/**
 * Anthropic Brain Adapter — converts between kernel intermediate representation
 * and Anthropic Messages API format.
 *
 * Key differences from OpenAI:
 *  - system prompt: separate `system` field, not in messages array
 *  - tool_calls: `content: [{ type: 'tool_use', id, name, input }]` (not function.arguments)
 *  - tool result: `{ role: 'user', content: [{ type: 'tool_result', tool_use_id, content }] }`
 *  - content: always array of content blocks (text, tool_use, tool_result)
 */

/**
 * Convert kernel (OpenAI-format) messages to Anthropic format.
 * Extracts system prompt into a separate field.
 *
 * @param {object[]} messages - kernel messages (OpenAI format)
 * @returns {{ system: string|null, messages: object[] }}
 */
export function toAnthropicMessages(messages) {
  let system = null;
  const anthropicMsgs = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      // Anthropic: system goes to a separate field (concatenate if multiple)
      system = system ? `${system}\n\n${msg.content}` : msg.content;
      continue;
    }

    if (msg.role === 'assistant') {
      const content = [];

      // Text content
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }

      // Tool calls → tool_use blocks
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          let input = {};
          try {
            input = typeof tc.function.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : tc.function.arguments || {};
          } catch { input = {}; }

          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
      }

      anthropicMsgs.push({
        role: 'assistant',
        content: content.length > 0 ? content : [{ type: 'text', text: '' }],
      });
      continue;
    }

    if (msg.role === 'tool') {
      // Anthropic: tool results go inside a user message as tool_result blocks
      // Check if previous message is already a user message with tool_results
      const last = anthropicMsgs[anthropicMsgs.length - 1];
      const resultBlock = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content: msg.content || '',
      };

      if (last && last.role === 'user' && Array.isArray(last.content) &&
          last.content.some(b => b.type === 'tool_result')) {
        // Append to existing tool_result user message
        last.content.push(resultBlock);
      } else {
        // Create new user message with tool_result
        anthropicMsgs.push({
          role: 'user',
          content: [resultBlock],
        });
      }
      continue;
    }

    if (msg.role === 'user') {
      // User message: wrap string content in text block
      const content = typeof msg.content === 'string'
        ? [{ type: 'text', text: msg.content }]
        : (Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content || '') }]);

      anthropicMsgs.push({ role: 'user', content });
      continue;
    }
  }

  return { system, messages: anthropicMsgs };
}

/**
 * Convert kernel capability schemas to Anthropic tool definitions.
 * @param {import('../schema.mjs').CapabilitySchema[]} capabilities
 * @returns {object[]} Anthropic tools format
 */
export function toAnthropicTools(capabilities) {
  return capabilities.map(cap => ({
    name: cap.name,
    description: cap.description,
    input_schema: cap.input_schema || { type: 'object', properties: {} },
  }));
}

/**
 * Convert an Anthropic tool_use content block to kernel intermediate representation.
 * @param {object} block - { type: 'tool_use', id, name, input }
 * @returns {{ name: string, input: object, call_id: string }}
 */
export function fromAnthropicToolUse(block) {
  return {
    name: block.name,
    input: block.input || {},
    call_id: block.id,
  };
}

/**
 * Build an Anthropic tool result user message from kernel execution result.
 * @param {string} name - capability name (for logging, not used in format)
 * @param {string} result - string result from gateway.execute
 * @param {string} callId - the tool_use_id to associate with
 * @returns {object} Anthropic user message with tool_result block
 */
export function toAnthropicToolResult(name, result, callId) {
  return {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: callId,
      content: result,
    }],
  };
}

/**
 * Convert an Anthropic API response to kernel intermediate representation.
 * @param {object} response - Anthropic Messages API response
 * @returns {{ content: string|null, tool_calls: object[], tokens: object, finish_reason: string }}
 */
export function fromAnthropicResponse(response) {
  let content = null;
  const toolCalls = [];

  for (const block of (response.content || [])) {
    if (block.type === 'text') {
      content = content ? `${content}\n${block.text}` : block.text;
    }
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        },
      });
    }
  }

  return {
    content,
    tool_calls: toolCalls,
    tokens: {
      input: response.usage?.input_tokens || 0,
      output: response.usage?.output_tokens || 0,
      total: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
    },
    finish_reason: response.stop_reason || 'end_turn',
  };
}
