import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createEventStore } from '../../kernel/event-store/index.mjs';
import { createSessionManager } from '../../kernel/session/index.mjs';

describe('Session', () => {
  let session;
  let eventStore;

  beforeEach(() => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    eventStore = createEventStore({ db });
    session = createSessionManager({ db, eventStore });
  });

  describe('create', () => {
    it('creates a session and returns ID', () => {
      const id = session.create({ owner: 'trader' });
      expect(id).toHaveLength(26);
    });

    it('emits session.created event', () => {
      const id = session.create({ owner: 'trader', metadata: { mode: 'crypto' } });
      const events = eventStore.getEvents({ type: 'session.created' });
      expect(events).toHaveLength(1);
      expect(events[0].payload.session_id).toBe(id);
      expect(events[0].payload.owner).toBe('trader');
    });

    it('rejects missing owner', () => {
      expect(() => session.create({})).toThrow('owner');
    });
  });

  describe('append + getContext', () => {
    it('appends messages and retrieves them', () => {
      const id = session.create({ owner: 'trader' });

      session.append(id, { role: 'user', content: 'What is BTC price?' });
      session.append(id, { role: 'assistant', content: 'BTC is at $68,420' });

      const messages = session.getContext(id);
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toBe('What is BTC price?');
      expect(messages[1].role).toBe('assistant');
    });

    it('preserves tool_calls format', () => {
      const id = session.create({ owner: 'trader' });

      session.append(id, {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'get_price', arguments: '{}' } }],
      });
      session.append(id, { role: 'tool', tool_call_id: 'tc1', content: '{"price":68420}' });

      const messages = session.getContext(id);
      expect(messages).toHaveLength(2);
      expect(messages[0].tool_calls).toHaveLength(1);
      expect(messages[0].tool_calls[0].function.name).toBe('get_price');
      expect(messages[1].role).toBe('tool');
      expect(messages[1].tool_call_id).toBe('tc1');
    });

    it('respects recent_n', () => {
      const id = session.create({ owner: 'trader' });
      for (let i = 0; i < 30; i++) {
        session.append(id, { role: 'user', content: `msg ${i}` });
      }
      const messages = session.getContext(id, { recent_n: 5 });
      expect(messages).toHaveLength(5);
      expect(messages[0].content).toBe('msg 25');
    });

    it('rejects append to non-existent session', () => {
      expect(() => session.append('fake', { role: 'user', content: 'hi' }))
        .toThrow('not found');
    });

    it('rejects append to archived session', () => {
      const id = session.create({ owner: 'trader' });
      session.archive(id);
      expect(() => session.append(id, { role: 'user', content: 'hi' }))
        .toThrow('archived');
    });
  });

  describe('archive', () => {
    it('archives a session', () => {
      const id = session.create({ owner: 'trader' });
      session.archive(id);

      const active = session.list({ active_only: true });
      expect(active).toHaveLength(0);
    });

    it('emits session.archived event', () => {
      const id = session.create({ owner: 'trader' });
      session.archive(id);
      const events = eventStore.getEvents({ type: 'session.archived' });
      expect(events).toHaveLength(1);
    });
  });

  describe('list', () => {
    it('lists all active sessions', () => {
      session.create({ owner: 'trader' });
      session.create({ owner: 'trader' });
      session.create({ owner: 'am' });

      expect(session.list()).toHaveLength(3);
      expect(session.list({ owner: 'trader' })).toHaveLength(2);
    });

    it('includes metadata', () => {
      session.create({ owner: 'trader', metadata: { mode: 'crypto' } });
      const [s] = session.list();
      expect(s.metadata.mode).toBe('crypto');
    });
  });

  describe('messageCount', () => {
    it('counts messages in session', () => {
      const id = session.create({ owner: 'trader' });
      session.append(id, { role: 'user', content: 'a' });
      session.append(id, { role: 'assistant', content: 'b' });
      expect(session.messageCount(id)).toBe(2);
    });
  });

  describe('session isolation', () => {
    it('messages from different sessions do not mix', () => {
      const s1 = session.create({ owner: 'trader' });
      const s2 = session.create({ owner: 'trader' });

      session.append(s1, { role: 'user', content: 'session 1' });
      session.append(s2, { role: 'user', content: 'session 2' });

      expect(session.getContext(s1)).toHaveLength(1);
      expect(session.getContext(s1)[0].content).toBe('session 1');
      expect(session.getContext(s2)).toHaveLength(1);
      expect(session.getContext(s2)[0].content).toBe('session 2');
    });
  });
});
