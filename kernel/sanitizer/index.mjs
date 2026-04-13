/**
 * Kernel Sanitizer — scrub secrets before they reach any LLM provider.
 *
 * Three layers:
 *   1. Exact-value match (registered secrets from vault)
 *   2. Pattern match (known token formats: sk-, ghp_, AKIA, Bearer, etc.)
 *   3. Entropy heuristic (high-entropy strings > 40 chars)
 *
 * Role-agnostic: doesn't know what Bitget or OpenAI is.
 */

/**
 * Compute Shannon entropy of a string (bits per character).
 * @param {string} s
 * @returns {number}
 */
function shannonEntropy(s) {
  if (!s || s.length === 0) return 0;
  const freq = {};
  for (const c of s) freq[c] = (freq[c] || 0) + 1;
  const len = s.length;
  let entropy = 0;
  for (const f of Object.values(freq)) {
    const p = f / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Default patterns for common secret formats. */
const DEFAULT_PATTERNS = [
  { name: 'openai_key',   regex: /sk-[a-zA-Z0-9]{20,}/g },
  { name: 'slack_token',   regex: /xoxb-[a-zA-Z0-9\-]{20,}/g },
  { name: 'github_pat',    regex: /ghp_[a-zA-Z0-9]{36,}/g },
  { name: 'github_ghs',    regex: /ghs_[a-zA-Z0-9]{36,}/g },
  { name: 'aws_key',       regex: /AKIA[0-9A-Z]{16}/g },
  { name: 'bearer_token',  regex: /Bearer\s+[a-zA-Z0-9._\-]{20,}/g },
  { name: 'bot_token',     regex: /\d{8,10}:[a-zA-Z0-9_-]{35}/g },  // Telegram bot token
];

/** Entropy thresholds for heuristic detection. */
const ENTROPY_MIN_LENGTH = 40;
const ENTROPY_THRESHOLD = 4.5;

/**
 * Create a Sanitizer instance.
 * @returns {Sanitizer}
 */
export function createSanitizer() {
  // { value: string, label: string }
  const secrets = [];
  // { name: string, regex: RegExp }
  const patterns = [...DEFAULT_PATTERNS];

  /**
   * Register an actual secret value to protect.
   * @param {string} value - the secret value
   * @param {string} label - display label (e.g. 'BITGET_API_KEY')
   */
  function registerSecret(value, label) {
    if (!value || typeof value !== 'string' || value.length < 4) return;
    // Avoid duplicates
    if (secrets.some(s => s.value === value)) return;
    secrets.push({ value, label });
  }

  /**
   * Register a custom pattern.
   * @param {string} name
   * @param {RegExp} regex - must have global flag
   */
  function registerPattern(name, regex) {
    patterns.push({ name, regex });
  }

  /**
   * Scrub a text string, replacing any detected secrets.
   * @param {string} text
   * @returns {{ text: string, redactions: Array<{ type: string, label: string }> }}
   */
  function scrub(text) {
    if (!text || typeof text !== 'string') return { text: text || '', redactions: [] };

    const redactions = [];
    let result = text;

    // Layer 1: Exact value match (highest priority)
    for (const { value, label } of secrets) {
      if (result.includes(value)) {
        const tag = `[REDACTED:${label}]`;
        while (result.includes(value)) {
          result = result.replace(value, tag);
          redactions.push({ type: 'secret', label });
        }
      }
    }

    // Layer 2: Pattern match
    for (const { name, regex } of patterns) {
      // Clone regex to reset lastIndex
      const re = new RegExp(regex.source, regex.flags);
      const matches = result.matchAll(re);
      for (const match of matches) {
        const tag = `[REDACTED:${name}]`;
        // Only redact if not already redacted
        if (!match[0].includes('[REDACTED:')) {
          result = result.replace(match[0], tag);
          redactions.push({ type: 'pattern', label: name });
        }
      }
    }

    // Layer 3: Entropy heuristic
    // Collect tokens first, then replace (avoid mutating string during iteration)
    const tokenRe = /[a-zA-Z0-9._\-+/=]{40,}/g;
    const entropyMatches = [];
    let m;
    while ((m = tokenRe.exec(result)) !== null) {
      const token = m[0];
      if (token.includes('REDACTED')) continue;
      const entropy = shannonEntropy(token);
      if (entropy >= ENTROPY_THRESHOLD) {
        entropyMatches.push({ token, entropy });
      }
    }
    for (const { token, entropy } of entropyMatches) {
      if (result.includes(token)) {
        const tag = '[REDACTED:entropy]';
        result = result.replace(token, tag);
        redactions.push({ type: 'entropy', label: `len=${token.length},ent=${entropy.toFixed(2)}` });
      }
    }

    return { text: result, redactions };
  }

  /**
   * Scrub all message contents in an LLM messages array.
   * Handles both string content and Anthropic content-block arrays.
   * @param {object[]} messages
   * @returns {{ messages: object[], redactions: Array }}
   */
  function scrubMessages(messages) {
    if (!Array.isArray(messages)) return { messages: messages || [], redactions: [] };

    const allRedactions = [];

    const scrubbed = messages.map(msg => {
      const out = { ...msg };

      if (typeof out.content === 'string') {
        const r = scrub(out.content);
        out.content = r.text;
        allRedactions.push(...r.redactions);
      } else if (Array.isArray(out.content)) {
        // Anthropic content blocks
        out.content = out.content.map(block => {
          if (block.type === 'text' && typeof block.text === 'string') {
            const r = scrub(block.text);
            allRedactions.push(...r.redactions);
            return { ...block, text: r.text };
          }
          return block;
        });
      }

      return out;
    });

    return { messages: scrubbed, redactions: allRedactions };
  }

  return {
    registerSecret,
    registerPattern,
    scrub,
    scrubMessages,
    // Exposed for testing
    _shannonEntropy: shannonEntropy,
  };
}
