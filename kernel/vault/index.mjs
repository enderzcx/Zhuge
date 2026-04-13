/**
 * Kernel Vault — generic secret storage with audit trail.
 *
 * Sprint 1 backend: process.env wrapper.
 * All values auto-register into sanitizer for leak prevention.
 */

/**
 * Create a Vault instance.
 * @param {{ sanitizer: import('../sanitizer/index.mjs').Sanitizer }} deps
 * @returns {Vault}
 */
export function createVault({ sanitizer }) {
  const store = new Map();   // key → value
  const auditLog = [];       // { key, accessor, ts }

  /**
   * Load secrets from an env-like map.
   * Each key is registered in the sanitizer automatically.
   * @param {Record<string, string>} envMap - { ENV_VAR_NAME: value }
   */
  function loadFromEnv(envMap) {
    for (const [key, value] of Object.entries(envMap)) {
      if (!value || typeof value !== 'string') continue;
      store.set(key, value);
      sanitizer.registerSecret(value, key);
    }
  }

  /**
   * Get a secret value by key.
   * @param {string} key
   * @param {string} [accessor='unknown'] - who is reading (for audit)
   * @returns {string|undefined}
   */
  function get(key, accessor = 'unknown') {
    auditLog.push({ key, accessor, ts: new Date().toISOString() });
    return store.get(key);
  }

  /**
   * List all stored key names (never values).
   * @returns {string[]}
   */
  function list() {
    return [...store.keys()];
  }

  /**
   * Get audit log entries.
   * @param {{ key?: string, since?: string, limit?: number }} [filter]
   * @returns {Array<{ key: string, accessor: string, ts: string }>}
   */
  function audit(filter = {}) {
    let entries = auditLog;
    if (filter.key) entries = entries.filter(e => e.key === filter.key);
    if (filter.since) entries = entries.filter(e => e.ts >= filter.since);
    if (filter.limit) entries = entries.slice(-filter.limit);
    return entries;
  }

  /**
   * Rotate a secret value. Updates store + re-registers in sanitizer.
   * @param {string} key
   * @param {string} newValue
   */
  function rotate(key, newValue) {
    store.set(key, newValue);
    sanitizer.registerSecret(newValue, key);
    auditLog.push({ key, accessor: 'vault.rotate', ts: new Date().toISOString() });
  }

  /**
   * Number of secrets stored.
   * @returns {number}
   */
  function size() {
    return store.size;
  }

  return { loadFromEnv, get, list, audit, rotate, size };
}
