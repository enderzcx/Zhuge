/**
 * OpenAI Brain Adapter — converts between kernel intermediate representation
 * and OpenAI function calling format.
 *
 * This adapter lets the kernel capability system work with OpenAI-compatible APIs
 * (which is what the current codebase uses via LLM_BASE_URL).
 */

/**
 * Convert kernel capability schemas to OpenAI tool definitions.
 * @param {import('../schema.mjs').CapabilitySchema[]} capabilities
 * @returns {object[]} OpenAI function calling format
 */
export function toOpenAITools(capabilities) {
  return capabilities.map(cap => ({
    type: 'function',
    function: {
      name: cap.name,
      description: cap.description,
      parameters: cap.input_schema || { type: 'object', properties: {}, required: [] },
    },
  }));
}

/**
 * Convert an OpenAI tool_call to kernel intermediate representation.
 * @param {object} toolCall - OpenAI tool_call object
 * @returns {{ name: string, input: object, call_id: string }}
 */
export function fromOpenAIToolCall(toolCall) {
  let input = {};
  try {
    input = typeof toolCall.function.arguments === 'string'
      ? JSON.parse(toolCall.function.arguments)
      : toolCall.function.arguments || {};
  } catch {
    input = {};
  }

  return {
    name: toolCall.function.name,
    input,
    call_id: toolCall.id,
  };
}

/**
 * Build an OpenAI tool result message from kernel execution result.
 * @param {string} name - capability name (unused in OpenAI format but kept for consistency)
 * @param {string} result - string result from gateway.execute
 * @param {string} callId - the tool_call id to associate with
 * @returns {object} OpenAI message object
 */
export function toOpenAIToolResult(name, result, callId) {
  return {
    role: 'tool',
    tool_call_id: callId,
    content: result,
  };
}

/**
 * Convert kernel intermediate message representation to OpenAI format.
 * This is a passthrough since kernel uses OpenAI-compatible format as baseline.
 * @param {object[]} messages - kernel messages
 * @returns {object[]} OpenAI messages
 */
export function toOpenAIMessages(messages) {
  return messages; // OpenAI format is our baseline
}
