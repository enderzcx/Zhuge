import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createMemory } from '../../kernel/memory/index.mjs';

describe('Memory API', () => {
  let memory;

  beforeEach(() => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    memory = createMemory({ db });
  });

  describe('write + read', () => {
    it('writes and reads a memory', () => {
      memory.write({ scope: 'trader.context', content: 'BTC is bullish today' });
      const entries = memory.read('trader.context');
      expect(entries).toHaveLength(1);
      expect(entries[0].content).toBe('BTC is bullish today');
      expect(entries[0].scope).toBe('trader.context');
    });

    it('writes with all fields', () => {
      const id = memory.write({
        scope: 'trader.notes',
        key: 'lesson-1',
        content: 'Never chase pumps',
        type: 'lesson',
        importance: 0.9,
      });
      expect(id).toHaveLength(26); // ULID

      const entries = memory.read('trader.notes');
      expect(entries[0].type).toBe('lesson');
      expect(entries[0].importance).toBe(0.9);
      expect(entries[0].key).toBe('lesson-1');
    });

    it('upserts by key', () => {
      memory.write({ scope: 's', key: 'ctx', content: 'v1' });
      memory.write({ scope: 's', key: 'ctx', content: 'v2' });
      const entries = memory.read('s', { key: 'ctx' });
      expect(entries).toHaveLength(1);
      expect(entries[0].content).toBe('v2');
    });

    it('rejects missing scope/content', () => {
      expect(() => memory.write({ scope: 'x' })).toThrow('content');
      expect(() => memory.write({ content: 'x' })).toThrow('scope');
    });
  });

  describe('scope isolation', () => {
    it('reads only from specified scope', () => {
      memory.write({ scope: 'trader', content: 'trade stuff' });
      memory.write({ scope: 'am', content: 'am stuff' });
      expect(memory.read('trader')).toHaveLength(1);
      expect(memory.read('am')).toHaveLength(1);
      expect(memory.read('unknown')).toHaveLength(0);
    });
  });

  describe('read filters', () => {
    it('filters by type', () => {
      memory.write({ scope: 's', content: 'a', type: 'note' });
      memory.write({ scope: 's', content: 'b', type: 'lesson' });
      expect(memory.read('s', { type: 'lesson' })).toHaveLength(1);
    });

    it('respects limit', () => {
      for (let i = 0; i < 10; i++) memory.write({ scope: 's', content: `m${i}` });
      expect(memory.read('s', { limit: 3 })).toHaveLength(3);
    });

    it('excludes archived by default', () => {
      memory.write({ scope: 's', content: 'active' });
      memory.write({ scope: 's', content: 'old' });
      memory.archive('s', '2099-01-01T00:00:00Z');
      expect(memory.read('s')).toHaveLength(0);
      expect(memory.read('s', { include_archived: true })).toHaveLength(2);
    });
  });

  describe('recall', () => {
    it('recalls by keyword match', () => {
      memory.write({ scope: 's', content: 'BTC pump detected with high volume' });
      memory.write({ scope: 's', content: 'ETH consolidation pattern forming' });
      memory.write({ scope: 's', content: 'SOL meme season incoming' });

      const results = memory.recall('BTC volume');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('BTC');
    });

    it('does not return unrelated recent memories', () => {
      memory.write({ scope: 's', content: 'completely unrelated recent note' });
      const results = memory.recall('btc volume');
      expect(results).toHaveLength(0);
    });

    it('returns empty for empty query', () => {
      memory.write({ scope: 's', content: 'something' });
      expect(memory.recall('')).toHaveLength(0);
    });

    it('filters by scope', () => {
      memory.write({ scope: 'trader', content: 'trade BTC now' });
      memory.write({ scope: 'am', content: 'rebalance BTC allocation' });

      const results = memory.recall('BTC', { scope: 'trader' });
      expect(results.every(r => r.scope === 'trader')).toBe(true);
    });

    it('respects limit', () => {
      for (let i = 0; i < 20; i++) memory.write({ scope: 's', content: `item ${i} with keyword search` });
      const results = memory.recall('keyword search', { limit: 3 });
      expect(results.length).toBeLessThanOrEqual(3);
    });
  });

  describe('delete', () => {
    it('deletes a memory by ID', () => {
      const id = memory.write({ scope: 's', content: 'to delete' });
      expect(memory.delete(id)).toBe(true);
      expect(memory.read('s')).toHaveLength(0);
    });

    it('returns false for non-existent ID', () => {
      expect(memory.delete('nonexistent')).toBe(false);
    });
  });

  describe('archive', () => {
    it('rewriting archived key revives it', () => {
      memory.write({ scope: 's', key: 'ctx', content: 'old', ts: '2020-01-01T00:00:00Z' });
      memory.archive('s', '2025-01-01T00:00:00Z');
      expect(memory.read('s', { key: 'ctx' })).toHaveLength(0); // archived
      memory.write({ scope: 's', key: 'ctx', content: 'revived' });
      const entries = memory.read('s', { key: 'ctx' });
      expect(entries).toHaveLength(1);
      expect(entries[0].content).toBe('revived');
      expect(entries[0].archived).toBe(0);
    });

    it('archives old memories', () => {
      memory.write({ scope: 's', content: 'old', ts: '2020-01-01T00:00:00Z' });
      memory.write({ scope: 's', content: 'new' });
      const count = memory.archive('s', '2025-01-01T00:00:00Z');
      expect(count).toBe(1);
      expect(memory.read('s')).toHaveLength(1);
      expect(memory.read('s')[0].content).toBe('new');
    });
  });
});
