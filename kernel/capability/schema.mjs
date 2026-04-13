/**
 * Kernel Capability Schema — intermediate representation for capabilities.
 *
 * This is the "LLVM IR" of capabilities: brain adapters convert to/from
 * provider-specific formats, but kernel only works with this shape.
 */

/**
 * @typedef {object} CapabilityDef
 * @property {string} name - Namespaced name, e.g. 'trader.open_position'
 * @property {string} description - Human-readable description
 * @property {object} input_schema - JSON Schema for input validation
 * @property {function} handler - async (input, ctx) => string
 * @property {string[]} [tags] - For group filtering / lazy loading
 * @property {'in-process'|'subprocess'|'wasi'} [sandbox='in-process']
 * @property {boolean} [mandate_check=false] - Whether to pass through mandate gate
 * @property {number} [max_result_chars=4000] - Output truncation limit
 */

/**
 * @typedef {object} CapabilitySchema
 * @property {string} name
 * @property {string} description
 * @property {object} input_schema
 * @property {string[]} tags
 * @property {boolean} mandate_check
 */

/**
 * Validate a capability definition at registration time.
 * @param {CapabilityDef} def
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateCapabilityDef(def) {
  const errors = [];

  if (!def || typeof def !== 'object') return { ok: false, errors: ['def must be an object'] };
  if (typeof def.name !== 'string' || !def.name) errors.push('name is required');
  if (typeof def.description !== 'string' || !def.description) errors.push('description is required');
  if (typeof def.handler !== 'function') errors.push('handler must be a function');
  if (def.input_schema !== undefined && typeof def.input_schema !== 'object') {
    errors.push('input_schema must be an object');
  }
  if (def.tags !== undefined && !Array.isArray(def.tags)) {
    errors.push('tags must be an array');
  }

  return { ok: errors.length === 0, errors };
}

/** Default output truncation limit. */
export const DEFAULT_MAX_RESULT_CHARS = 4000;
