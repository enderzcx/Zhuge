/**
 * Event envelope — schema validation + ULID generation.
 *
 * ULID: 26-char Crockford Base32, time-ordered, monotonic within ms.
 * No npm dep — self-contained.
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

let _lastTime = 0;
let _lastRandom = new Array(16).fill(0);

/**
 * Generate a ULID (Universally Unique Lexicographically Sortable Identifier).
 * 10 chars time (48-bit ms) + 16 chars randomness (80-bit).
 * Monotonic: if same ms as last call, increment random part.
 */
export function ulid() {
  const now = Date.now();

  // Time component: 10 chars encoding 48-bit ms timestamp
  let time = '';
  let t = now;
  for (let i = 9; i >= 0; i--) {
    time = ENCODING[t & 31] + time;
    t = Math.floor(t / 32);
  }

  // Random component: 16 chars
  if (now === _lastTime) {
    // Monotonic increment within same ms
    let carry = true;
    for (let i = 15; i >= 0 && carry; i--) {
      _lastRandom[i]++;
      if (_lastRandom[i] >= 32) {
        _lastRandom[i] = 0;
      } else {
        carry = false;
      }
    }
  } else {
    _lastTime = now;
    for (let i = 0; i < 16; i++) {
      _lastRandom[i] = Math.floor(Math.random() * 32);
    }
  }

  let random = '';
  for (let i = 0; i < 16; i++) {
    random += ENCODING[_lastRandom[i]];
  }

  return time + random;
}

/**
 * Validate an event envelope. Returns { ok, errors }.
 * @param {object} event
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateEnvelope(event) {
  const errors = [];

  if (!event || typeof event !== 'object') {
    return { ok: false, errors: ['event must be an object'] };
  }
  if (typeof event.type !== 'string' || !event.type) {
    errors.push('type is required and must be a non-empty string');
  }
  if (typeof event.actor !== 'string' || !event.actor) {
    errors.push('actor is required and must be a non-empty string');
  }
  if (event.ts !== undefined && typeof event.ts !== 'string') {
    errors.push('ts must be a string (ISO 8601)');
  }
  if (event.trace_id !== undefined && event.trace_id !== null && typeof event.trace_id !== 'string') {
    errors.push('trace_id must be a string or null');
  }
  if (event.parent_id !== undefined && event.parent_id !== null && typeof event.parent_id !== 'string') {
    errors.push('parent_id must be a string or null');
  }
  if (event.payload !== undefined && typeof event.payload !== 'object') {
    errors.push('payload must be an object');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Build a complete event envelope with defaults.
 * @param {object} partial - at minimum { type, actor }
 * @returns {object} complete envelope
 */
export function buildEnvelope(partial) {
  return {
    id: partial.id || ulid(),
    type: partial.type,
    ts: partial.ts || new Date().toISOString(),
    actor: partial.actor,
    trace_id: partial.trace_id || null,
    parent_id: partial.parent_id || null,
    payload: partial.payload || {},
  };
}
