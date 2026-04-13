import { describe, it, expect, beforeEach } from 'vitest';
import { createSanitizer } from '../../kernel/sanitizer/index.mjs';
import { createVault } from '../../kernel/vault/index.mjs';

describe('Vault', () => {
  let vault;
  let sanitizer;

  beforeEach(() => {
    sanitizer = createSanitizer();
    vault = createVault({ sanitizer });
  });

  describe('loadFromEnv', () => {
    it('loads secrets from env map', () => {
      vault.loadFromEnv({
        API_KEY: 'secret-key-12345',
        DB_PASS: 'p@ssw0rd-complex',
      });
      expect(vault.size()).toBe(2);
    });

    it('skips empty/null values', () => {
      vault.loadFromEnv({
        GOOD: 'value-here',
        EMPTY: '',
        NULL: null,
        UNDEF: undefined,
      });
      expect(vault.size()).toBe(1);
    });

    it('auto-registers secrets in sanitizer', () => {
      vault.loadFromEnv({ SECRET: 'my-vault-secret-value-here' });
      const { text } = sanitizer.scrub('data contains my-vault-secret-value-here inside');
      expect(text).toContain('[REDACTED:SECRET]');
      expect(text).not.toContain('my-vault-secret');
    });
  });

  describe('get', () => {
    it('returns stored value', () => {
      vault.loadFromEnv({ KEY: 'val123' });
      expect(vault.get('KEY')).toBe('val123');
    });

    it('returns undefined for missing key', () => {
      expect(vault.get('NOPE')).toBeUndefined();
    });

    it('records audit entry', () => {
      vault.loadFromEnv({ KEY: 'val' });
      vault.get('KEY', 'brain-adapter');
      const entries = vault.audit();
      expect(entries).toHaveLength(1);
      expect(entries[0].key).toBe('KEY');
      expect(entries[0].accessor).toBe('brain-adapter');
    });
  });

  describe('list', () => {
    it('returns key names only', () => {
      vault.loadFromEnv({ A: 'secret-a', B: 'secret-b' });
      const keys = vault.list();
      expect(keys).toContain('A');
      expect(keys).toContain('B');
      expect(keys.join(' ')).not.toContain('secret');
    });
  });

  describe('audit', () => {
    it('records all get calls', () => {
      vault.loadFromEnv({ X: 'val', Y: 'val2' });
      vault.get('X', 'caller1');
      vault.get('Y', 'caller2');
      vault.get('X', 'caller3');
      const entries = vault.audit();
      expect(entries).toHaveLength(3);
    });

    it('filters by key', () => {
      vault.loadFromEnv({ X: 'val', Y: 'val2' });
      vault.get('X');
      vault.get('Y');
      vault.get('X');
      const entries = vault.audit({ key: 'X' });
      expect(entries).toHaveLength(2);
    });

    it('filters by limit', () => {
      vault.loadFromEnv({ X: 'val' });
      for (let i = 0; i < 10; i++) vault.get('X');
      const entries = vault.audit({ limit: 3 });
      expect(entries).toHaveLength(3);
    });
  });

  describe('rotate', () => {
    it('updates stored value', () => {
      vault.loadFromEnv({ KEY: 'old-val' });
      vault.rotate('KEY', 'new-val-here-12345');
      expect(vault.get('KEY')).toBe('new-val-here-12345');
    });

    it('registers new value in sanitizer', () => {
      vault.loadFromEnv({ KEY: 'old-val' });
      vault.rotate('KEY', 'rotated-secret-value-xyz');
      const { text } = sanitizer.scrub('contains rotated-secret-value-xyz');
      expect(text).toContain('[REDACTED:KEY]');
    });

    it('records audit entry', () => {
      vault.loadFromEnv({ KEY: 'old' });
      vault.rotate('KEY', 'new');
      const entries = vault.audit({ key: 'KEY' });
      expect(entries.some(e => e.accessor === 'vault.rotate')).toBe(true);
    });
  });

  describe('integration: vault + sanitizer leak prevention', () => {
    it('any vault secret is caught by sanitizer in LLM messages', () => {
      vault.loadFromEnv({
        BITGET_API_KEY: 'bg_abcdef1234567890abcdef',
        BITGET_SECRET: 'secretkey_xyz_987654321',
        TG_BOT_TOKEN: '1234567890:ABCdefGHI-jklMNO_pqrSTUvwxyz12345',
      });

      const messages = [
        { role: 'system', content: 'Config: bg_abcdef1234567890abcdef' },
        { role: 'user', content: 'token is 1234567890:ABCdefGHI-jklMNO_pqrSTUvwxyz12345' },
      ];

      const { messages: scrubbed } = sanitizer.scrubMessages(messages);
      expect(scrubbed[0].content).not.toContain('bg_abcdef');
      expect(scrubbed[1].content).not.toContain('ABCdefGHI');
    });
  });
});
