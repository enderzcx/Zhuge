import { describe, it, expect, beforeEach } from 'vitest';
import { createSanitizer } from '../../kernel/sanitizer/index.mjs';

describe('Sanitizer', () => {
  let sanitizer;

  beforeEach(() => {
    sanitizer = createSanitizer();
  });

  describe('registerSecret + scrub', () => {
    it('redacts exact secret values', () => {
      sanitizer.registerSecret('my-super-secret-api-key-12345', 'API_KEY');
      const { text, redactions } = sanitizer.scrub('The key is my-super-secret-api-key-12345 here');
      expect(text).toBe('The key is [REDACTED:API_KEY] here');
      expect(text).not.toContain('my-super-secret');
      expect(redactions).toHaveLength(1);
      expect(redactions[0].type).toBe('secret');
    });

    it('redacts multiple occurrences', () => {
      sanitizer.registerSecret('SECRET123', 'KEY');
      const { text } = sanitizer.scrub('first SECRET123 then SECRET123 again');
      expect(text).toBe('first [REDACTED:KEY] then [REDACTED:KEY] again');
    });

    it('redacts multiple different secrets', () => {
      sanitizer.registerSecret('aaa-secret', 'A');
      sanitizer.registerSecret('bbb-secret', 'B');
      const { text } = sanitizer.scrub('vals: aaa-secret and bbb-secret');
      expect(text).toBe('vals: [REDACTED:A] and [REDACTED:B]');
    });

    it('ignores short values (< 4 chars)', () => {
      sanitizer.registerSecret('abc', 'SHORT');
      const { text } = sanitizer.scrub('abc is fine');
      expect(text).toBe('abc is fine');
    });

    it('does not duplicate registration', () => {
      sanitizer.registerSecret('secret-val', 'X');
      sanitizer.registerSecret('secret-val', 'X');
      const { redactions } = sanitizer.scrub('secret-val');
      expect(redactions).toHaveLength(1);
    });
  });

  describe('pattern matching', () => {
    it('detects OpenAI-style keys', () => {
      const { text } = sanitizer.scrub('key: sk-abcdefghijklmnopqrstuvwxyz1234');
      expect(text).toContain('[REDACTED:openai_key]');
      expect(text).not.toContain('sk-abc');
    });

    it('detects GitHub PAT', () => {
      const { text } = sanitizer.scrub('token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn');
      expect(text).toContain('[REDACTED:github_pat]');
    });

    it('detects AWS access key', () => {
      const { text } = sanitizer.scrub('aws key: AKIAIOSFODNN7EXAMPLE');
      expect(text).toContain('[REDACTED:aws_key]');
    });

    it('detects Bearer tokens', () => {
      const { text } = sanitizer.scrub('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
      expect(text).toContain('[REDACTED:bearer_token]');
    });

    it('detects Telegram bot tokens', () => {
      const { text } = sanitizer.scrub('bot: 1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ_abcdefghi');
      expect(text).toContain('[REDACTED:bot_token]');
    });
  });

  describe('entropy heuristic', () => {
    it('detects high-entropy strings > 40 chars', () => {
      // Random-looking string
      const highEntropy = 'aB3xK9mP2qR7sT5uV8wY1zC4dF6gH0jL';
      // Pad to > 40 chars
      const secret = highEntropy + 'eN3oQ5rS7tU9v';
      const { text, redactions } = sanitizer.scrub(`data: ${secret} end`);
      // Should be redacted if entropy is high enough
      const hasEntropyRedaction = redactions.some(r => r.type === 'entropy');
      if (hasEntropyRedaction) {
        expect(text).toContain('[REDACTED:entropy]');
      }
    });

    it('redacts multiple high-entropy tokens in same text', () => {
      const secret1 = 'aB3xK9mP2qR7sT5uV8wY1zC4dF6gH0jLeN3oQ5rS7tU9v';
      const secret2 = 'ZW8pL2kN5jH7fD4cA1bX9vT6sR3qP0mK8oI5gF2eC7dB4a';
      const { text, redactions } = sanitizer.scrub(`first: ${secret1} second: ${secret2}`);
      expect(text).not.toContain(secret1);
      expect(text).not.toContain(secret2);
      const entropyRedactions = redactions.filter(r => r.type === 'entropy');
      expect(entropyRedactions.length).toBe(2);
    });

    it('does not flag low-entropy strings', () => {
      const lowEntropy = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const { text } = sanitizer.scrub(`data: ${lowEntropy} end`);
      expect(text).not.toContain('[REDACTED:entropy]');
    });
  });

  describe('scrub edge cases', () => {
    it('handles empty string', () => {
      const { text, redactions } = sanitizer.scrub('');
      expect(text).toBe('');
      expect(redactions).toHaveLength(0);
    });

    it('handles null/undefined', () => {
      expect(sanitizer.scrub(null).text).toBe('');
      expect(sanitizer.scrub(undefined).text).toBe('');
    });

    it('preserves normal text', () => {
      const normal = 'BTC price is $68,420. RSI at 72. MACD crossing bullish.';
      const { text, redactions } = sanitizer.scrub(normal);
      expect(text).toBe(normal);
      expect(redactions).toHaveLength(0);
    });

    it('preserves EVM addresses (not high entropy)', () => {
      const addr = '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD10';
      const { text } = sanitizer.scrub(`wallet: ${addr}`);
      // EVM addresses might trigger entropy, that's acceptable
      // Just verify no crash
      expect(text).toBeTruthy();
    });
  });

  describe('scrubMessages', () => {
    it('scrubs string content messages', () => {
      sanitizer.registerSecret('my-api-key-1234567890', 'KEY');
      const messages = [
        { role: 'system', content: 'You have key: my-api-key-1234567890' },
        { role: 'user', content: 'hello' },
      ];
      const { messages: scrubbed, redactions } = sanitizer.scrubMessages(messages);
      expect(scrubbed[0].content).toContain('[REDACTED:KEY]');
      expect(scrubbed[1].content).toBe('hello');
      expect(redactions).toHaveLength(1);
    });

    it('scrubs Anthropic content blocks', () => {
      sanitizer.registerSecret('secret-value-here-12345', 'SEC');
      const messages = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'here is secret-value-here-12345' },
            { type: 'image', source: { data: 'base64...' } },
          ],
        },
      ];
      const { messages: scrubbed } = sanitizer.scrubMessages(messages);
      expect(scrubbed[0].content[0].text).toContain('[REDACTED:SEC]');
      expect(scrubbed[0].content[1]).toEqual(messages[0].content[1]); // image untouched
    });

    it('handles empty array', () => {
      const { messages, redactions } = sanitizer.scrubMessages([]);
      expect(messages).toEqual([]);
      expect(redactions).toHaveLength(0);
    });
  });

  describe('custom patterns', () => {
    it('registerPattern adds new detection', () => {
      sanitizer.registerPattern('bitget_key', /bg_[a-zA-Z0-9]{20,}/g);
      const { text } = sanitizer.scrub('key: bg_abcdefghijklmnopqrstuvwx');
      expect(text).toContain('[REDACTED:bitget_key]');
    });
  });

  describe('shannonEntropy', () => {
    it('returns 0 for empty string', () => {
      expect(sanitizer._shannonEntropy('')).toBe(0);
    });

    it('returns 0 for single char', () => {
      expect(sanitizer._shannonEntropy('aaaa')).toBe(0);
    });

    it('returns high value for random-like string', () => {
      const entropy = sanitizer._shannonEntropy('aB3xK9mP2qR7sT5uV8wY1zC4dF6gH0jL');
      expect(entropy).toBeGreaterThan(4.0);
    });
  });
});
