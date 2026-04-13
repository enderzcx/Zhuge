/**
 * Kernel Capability Gateway — unified execute(name, input) entry point.
 *
 * All capability invocations go through here.
 * Handles: validation → execution → event emission → output truncation.
 *
 * Sprint 1: no mandate gate check (Sprint 2), no input sanitizer (brain adapter does it).
 */

import { DEFAULT_MAX_RESULT_CHARS } from './schema.mjs';

/**
 * Simple JSON Schema validation (subset — handles type, required, properties).
 * Not a full validator — covers the 90% case for tool input schemas.
 * @param {object} input
 * @param {object} schema
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateInput(input, schema) {
  if (!schema || !schema.properties) return { ok: true, errors: [] };

  // Check top-level type
  if (schema.type === 'object') {
    if (input === null || input === undefined) {
      // null/undefined with no required fields is ok (handler gets {})
      if (!schema.required || schema.required.length === 0) return { ok: true, errors: [] };
      return { ok: false, errors: ['input must be an object'] };
    }
    if (typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, errors: ['input must be an object'] };
    }
  }

  const errors = [];
  const safeInput = input || {};

  // Check required
  if (schema.required) {
    for (const key of schema.required) {
      if (safeInput[key] === undefined || safeInput[key] === null) {
        errors.push(`missing required field: ${key}`);
      }
    }
  }

  // Check types (basic)
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (safeInput[key] === undefined) continue;
    const val = safeInput[key];
    if (prop.type === 'string' && typeof val !== 'string') errors.push(`${key} must be string`);
    if (prop.type === 'number' && typeof val !== 'number') errors.push(`${key} must be number`);
    if (prop.type === 'boolean' && typeof val !== 'boolean') errors.push(`${key} must be boolean`);
    if (prop.type === 'array' && !Array.isArray(val)) errors.push(`${key} must be array`);
    if (prop.type === 'object' && (typeof val !== 'object' || Array.isArray(val))) errors.push(`${key} must be object`);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Create a Capability Gateway.
 *
 * @param {{
 *   registry: import('./registry.mjs').CapabilityRegistry,
 *   eventStore?: import('../event-store/index.mjs').EventStore,
 *   log?: object
 * }} deps
 * @returns {CapabilityGateway}
 */
export function createCapabilityGateway({ registry, eventStore, mandateGate, log }) {
  const _log = log || { info() {}, warn() {}, error() {} };

  /**
   * Execute a capability by name.
   *
   * @param {string} name - capability name
   * @param {object} input - input arguments
   * @param {{ trace_id?: string, actor?: string }} [ctx] - execution context
   * @returns {Promise<string>} result string
   * @throws if capability unknown or input invalid
   */
  async function execute(name, input, ctx = {}) {
    const cap = registry.get(name);
    if (!cap) {
      const err = `Unknown capability: ${name}`;
      _log.warn('capability_unknown', { name });
      throw new Error(err);
    }

    // Validate input (raw, before fallback — so null/string/array are rejected)
    const { ok, errors } = validateInput(input, cap.input_schema);
    if (!ok) {
      const err = `Validation failed for '${name}': ${errors.join(', ')}`;
      _log.warn('capability_validation_failed', { name, errors });
      throw new Error(err);
    }

    // Mandate gate check (if capability requires it and gate is available)
    if (cap.mandate_check && mandateGate) {
      // Derive harness name from capability namespace (e.g. 'trader.open_position' → 'trader')
      const harnessName = name.includes('.') ? name.split('.')[0] : 'default';
      const action = name.includes('.') ? name.split('.').slice(1).join('.') : name;
      const mandateCtx = { ...input, action, ...(ctx.mandate_context || {}) };
      const verdict = mandateGate.check(harnessName, action, mandateCtx);
      if (!verdict.pass) {
        const err = `Mandate VETO on '${name}': ${verdict.vetoed_by?.message || 'blocked'}`;
        _log.warn('mandate_veto', { name, rule: verdict.vetoed_by?.id });
        if (eventStore) {
          try {
            eventStore.emit({
              type: 'mandate.veto',
              actor: ctx.actor || 'gateway',
              trace_id: ctx.trace_id,
              payload: { name, rule_id: verdict.vetoed_by?.id, message: verdict.vetoed_by?.message },
            });
          } catch {}
        }
        throw new Error(err);
      }
    }

    // Execute (default to {} for handler convenience)
    const startMs = Date.now();
    let result;
    let error;
    try {
      result = await cap.handler(input || {}, ctx);
      // Ensure string output
      if (result === undefined || result === null) {
        result = '';
      } else if (typeof result !== 'string') {
        result = JSON.stringify(result);
      }
    } catch (err) {
      error = err;
      result = JSON.stringify({ error: err.message });
    }
    const durationMs = Date.now() - startMs;

    // Emit event (non-blocking, best-effort)
    if (eventStore) {
      try {
        eventStore.emit({
          type: 'capability.executed',
          actor: ctx.actor || 'gateway',
          trace_id: ctx.trace_id,
          payload: {
            name,
            duration_ms: durationMs,
            ok: !error,
            error: error?.message,
          },
        });
      } catch (e) {
        _log.warn('event_emit_failed', { name, error: e.message });
      }
    }

    // Re-throw if execution failed
    if (error) throw error;

    // Truncate output
    const maxChars = cap.max_result_chars || DEFAULT_MAX_RESULT_CHARS;
    if (result.length > maxChars) {
      result = result.slice(0, maxChars) + `\n...[truncated ${result.length - maxChars} chars]`;
    }

    return result;
  }

  return { execute };
}
