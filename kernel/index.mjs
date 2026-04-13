/**
 * Kernel barrel export — single entry point for all kernel primitives.
 *
 * Usage:
 *   import { createEventStore, createSanitizer, createVault, ... } from './kernel/index.mjs'
 */

// Sprint 1
export { createEventStore, initEventStoreSchema } from './event-store/index.mjs';
export { ulid, validateEnvelope, buildEnvelope } from './event-store/envelope.mjs';
export { createSanitizer } from './sanitizer/index.mjs';
export { createVault } from './vault/index.mjs';
export { createCapabilityRegistry } from './capability/registry.mjs';
export { createCapabilityGateway } from './capability/gateway.mjs';
export { validateCapabilityDef, DEFAULT_MAX_RESULT_CHARS } from './capability/schema.mjs';
export { toOpenAITools, fromOpenAIToolCall, toOpenAIToolResult } from './capability/adapters/openai.mjs';

// Sprint 2
export { createMandateGate } from './mandate/gate.mjs';
export { evaluate, interpolate } from './mandate/evaluator.mjs';
export { createMemory, initMemorySchema } from './memory/index.mjs';
export { createSessionManager, initSessionSchema } from './session/index.mjs';
export {
  toAnthropicMessages, toAnthropicTools,
  fromAnthropicToolUse, toAnthropicToolResult, fromAnthropicResponse,
} from './capability/adapters/anthropic.mjs';
