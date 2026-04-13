/**
 * Kernel Capability Registry — register, list, and lookup capabilities.
 *
 * Role-agnostic: doesn't know what 'trader.open_position' means.
 * Harness registers capabilities at startup; brain adapter reads the list.
 */

import { validateCapabilityDef, DEFAULT_MAX_RESULT_CHARS } from './schema.mjs';

/**
 * Create a Capability Registry.
 * @returns {CapabilityRegistry}
 */
export function createCapabilityRegistry() {
  /** @type {Map<string, CapabilityDef>} */
  const capabilities = new Map();

  /**
   * Register a capability.
   * @param {import('./schema.mjs').CapabilityDef} def
   * @throws if definition is invalid or name already registered
   */
  function register(def) {
    const { ok, errors } = validateCapabilityDef(def);
    if (!ok) throw new Error(`Invalid capability '${def?.name}': ${errors.join(', ')}`);
    if (capabilities.has(def.name)) {
      throw new Error(`Capability '${def.name}' already registered`);
    }

    capabilities.set(def.name, {
      sandbox: 'in-process',
      mandate_check: false,
      tags: [],
      max_result_chars: DEFAULT_MAX_RESULT_CHARS,
      ...def,
    });
  }

  /**
   * Register multiple capabilities at once.
   * @param {import('./schema.mjs').CapabilityDef[]} defs
   */
  function registerAll(defs) {
    for (const def of defs) register(def);
  }

  /**
   * Get a capability by name (includes handler).
   * @param {string} name
   * @returns {CapabilityDef|null}
   */
  function get(name) {
    return capabilities.get(name) || null;
  }

  /**
   * List capability schemas (without handlers — safe to serialize).
   * @param {{ tags?: string[], name_prefix?: string }} [filter]
   * @returns {import('./schema.mjs').CapabilitySchema[]}
   */
  function list(filter = {}) {
    let entries = [...capabilities.values()];

    if (filter.tags && filter.tags.length > 0) {
      entries = entries.filter(cap =>
        filter.tags.some(tag => cap.tags.includes(tag))
      );
    }
    if (filter.name_prefix) {
      entries = entries.filter(cap => cap.name.startsWith(filter.name_prefix));
    }

    return entries.map(cap => ({
      name: cap.name,
      description: cap.description,
      input_schema: cap.input_schema || { type: 'object', properties: {}, required: [] },
      tags: cap.tags,
      mandate_check: cap.mandate_check,
    }));
  }

  /**
   * Check if a capability exists.
   * @param {string} name
   * @returns {boolean}
   */
  function has(name) {
    return capabilities.has(name);
  }

  /**
   * Number of registered capabilities.
   * @returns {number}
   */
  function size() {
    return capabilities.size;
  }

  return { register, registerAll, get, list, has, size };
}
