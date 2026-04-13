import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createCapabilityRegistry } from '../../kernel/capability/registry.mjs';
import { createCapabilityGateway } from '../../kernel/capability/gateway.mjs';
import { createEventStore } from '../../kernel/event-store/index.mjs';
import { toOpenAITools, fromOpenAIToolCall, toOpenAIToolResult } from '../../kernel/capability/adapters/openai.mjs';

describe('CapabilityRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = createCapabilityRegistry();
  });

  it('registers a capability', () => {
    registry.register({
      name: 'test.echo',
      description: 'Echo input',
      handler: async (input) => JSON.stringify(input),
    });
    expect(registry.has('test.echo')).toBe(true);
    expect(registry.size()).toBe(1);
  });

  it('rejects duplicate names', () => {
    registry.register({ name: 'a', description: 'd', handler: async () => '' });
    expect(() => registry.register({ name: 'a', description: 'd', handler: async () => '' }))
      .toThrow('already registered');
  });

  it('rejects invalid definitions', () => {
    expect(() => registry.register({ description: 'd', handler: async () => '' }))
      .toThrow('name');
    expect(() => registry.register({ name: 'a', description: 'd' }))
      .toThrow('handler');
  });

  it('get returns full definition including handler', () => {
    const handler = async () => 'result';
    registry.register({ name: 'x', description: 'd', handler });
    const cap = registry.get('x');
    expect(cap.handler).toBe(handler);
    expect(cap.sandbox).toBe('in-process');
    expect(cap.mandate_check).toBe(false);
  });

  it('get returns null for unknown', () => {
    expect(registry.get('nope')).toBeNull();
  });

  it('list returns schemas without handlers', () => {
    registry.register({ name: 'a', description: 'A', handler: async () => '', tags: ['read'] });
    registry.register({ name: 'b', description: 'B', handler: async () => '', tags: ['write'] });
    const schemas = registry.list();
    expect(schemas).toHaveLength(2);
    expect(schemas[0].handler).toBeUndefined();
    expect(schemas[0].input_schema).toBeDefined();
  });

  it('list filters by tags', () => {
    registry.register({ name: 'a', description: 'A', handler: async () => '', tags: ['trade'] });
    registry.register({ name: 'b', description: 'B', handler: async () => '', tags: ['data'] });
    registry.register({ name: 'c', description: 'C', handler: async () => '', tags: ['trade', 'data'] });

    expect(registry.list({ tags: ['trade'] })).toHaveLength(2);
    expect(registry.list({ tags: ['data'] })).toHaveLength(2);
    expect(registry.list({ tags: ['unknown'] })).toHaveLength(0);
  });

  it('list filters by name_prefix', () => {
    registry.register({ name: 'trader.price', description: 'd', handler: async () => '' });
    registry.register({ name: 'trader.balance', description: 'd', handler: async () => '' });
    registry.register({ name: 'am.rebalance', description: 'd', handler: async () => '' });

    expect(registry.list({ name_prefix: 'trader.' })).toHaveLength(2);
    expect(registry.list({ name_prefix: 'am.' })).toHaveLength(1);
  });

  it('registerAll registers multiple', () => {
    registry.registerAll([
      { name: 'a', description: 'A', handler: async () => '' },
      { name: 'b', description: 'B', handler: async () => '' },
    ]);
    expect(registry.size()).toBe(2);
  });
});

describe('CapabilityGateway', () => {
  let gateway;
  let registry;
  let eventStore;

  beforeEach(() => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    eventStore = createEventStore({ db });
    registry = createCapabilityRegistry();
    gateway = createCapabilityGateway({ registry, eventStore });
  });

  it('executes a capability and returns string', async () => {
    registry.register({
      name: 'echo',
      description: 'Echo',
      handler: async (input) => `Hello ${input.name}`,
    });
    const result = await gateway.execute('echo', { name: 'World' });
    expect(result).toBe('Hello World');
  });

  it('converts non-string handler output to JSON', async () => {
    registry.register({
      name: 'obj',
      description: 'Object',
      handler: async () => ({ foo: 42 }),
    });
    const result = await gateway.execute('obj', {});
    expect(JSON.parse(result)).toEqual({ foo: 42 });
  });

  it('throws on unknown capability', async () => {
    await expect(gateway.execute('nope', {})).rejects.toThrow('Unknown capability');
  });

  it('validates input against schema', async () => {
    registry.register({
      name: 'strict',
      description: 'Strict',
      input_schema: {
        type: 'object',
        required: ['symbol'],
        properties: { symbol: { type: 'string' } },
      },
      handler: async (input) => input.symbol,
    });
    await expect(gateway.execute('strict', {})).rejects.toThrow('missing required');
    await expect(gateway.execute('strict', { symbol: 123 })).rejects.toThrow('must be string');
  });

  it('emits capability.executed event', async () => {
    registry.register({
      name: 'tracked',
      description: 'Tracked',
      handler: async () => 'ok',
    });
    await gateway.execute('tracked', {}, { trace_id: 'tr1', actor: 'test' });

    const events = eventStore.getEvents({ type: 'capability.executed' });
    expect(events).toHaveLength(1);
    expect(events[0].payload.name).toBe('tracked');
    expect(events[0].payload.ok).toBe(true);
    expect(events[0].payload.duration_ms).toBeGreaterThanOrEqual(0);
    expect(events[0].trace_id).toBe('tr1');
  });

  it('emits event on handler error too', async () => {
    registry.register({
      name: 'fail',
      description: 'Fail',
      handler: async () => { throw new Error('boom'); },
    });
    await expect(gateway.execute('fail', {})).rejects.toThrow('boom');

    const events = eventStore.getEvents({ type: 'capability.executed' });
    expect(events).toHaveLength(1);
    expect(events[0].payload.ok).toBe(false);
    expect(events[0].payload.error).toBe('boom');
  });

  it('truncates long output', async () => {
    registry.register({
      name: 'big',
      description: 'Big',
      max_result_chars: 100,
      handler: async () => 'x'.repeat(200),
    });
    const result = await gateway.execute('big', {});
    expect(result.length).toBeLessThan(200);
    expect(result).toContain('truncated');
  });

  it('handles undefined return from handler', async () => {
    registry.register({
      name: 'void',
      description: 'Side-effect only',
      handler: async () => { /* no return */ },
    });
    const result = await gateway.execute('void', {});
    expect(result).toBe('');
  });

  it('rejects non-object input when schema requires object', async () => {
    registry.register({
      name: 'strict_obj',
      description: 'Needs object',
      input_schema: {
        type: 'object',
        properties: { x: { type: 'string' } },
      },
      handler: async (input) => JSON.stringify(input),
    });
    await expect(gateway.execute('strict_obj', 'oops')).rejects.toThrow('must be an object');
    await expect(gateway.execute('strict_obj', [1, 2])).rejects.toThrow('must be an object');
    // null with no required fields is ok (handler gets {})
    const nullResult = await gateway.execute('strict_obj', null);
    expect(nullResult).toBeTruthy();
  });

  it('rejects null input when schema has required fields', async () => {
    registry.register({
      name: 'needs_fields',
      description: 'Needs fields',
      input_schema: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      handler: async (input) => input.name,
    });
    await expect(gateway.execute('needs_fields', null)).rejects.toThrow('must be an object');
  });

  it('works without eventStore', async () => {
    const gw = createCapabilityGateway({ registry });
    registry.register({ name: 'simple', description: 'S', handler: async () => 'ok' });
    const result = await gw.execute('simple', {});
    expect(result).toBe('ok');
  });
});

describe('OpenAI Adapter', () => {
  it('toOpenAITools converts kernel schemas', () => {
    const schemas = [
      {
        name: 'trader.price',
        description: 'Get price',
        input_schema: {
          type: 'object',
          required: ['symbol'],
          properties: { symbol: { type: 'string' } },
        },
        tags: ['data'],
        mandate_check: false,
      },
    ];
    const tools = toOpenAITools(schemas);
    expect(tools).toHaveLength(1);
    expect(tools[0].type).toBe('function');
    expect(tools[0].function.name).toBe('trader.price');
    expect(tools[0].function.parameters.required).toContain('symbol');
  });

  it('fromOpenAIToolCall parses tool call', () => {
    const toolCall = {
      id: 'call_abc123',
      function: {
        name: 'trader.price',
        arguments: '{"symbol":"BTC-USDT"}',
      },
    };
    const { name, input, call_id } = fromOpenAIToolCall(toolCall);
    expect(name).toBe('trader.price');
    expect(input.symbol).toBe('BTC-USDT');
    expect(call_id).toBe('call_abc123');
  });

  it('fromOpenAIToolCall handles invalid JSON', () => {
    const { input } = fromOpenAIToolCall({
      id: 'x',
      function: { name: 'a', arguments: 'not json' },
    });
    expect(input).toEqual({});
  });

  it('toOpenAIToolResult builds correct message', () => {
    const msg = toOpenAIToolResult('trader.price', '{"price":68420}', 'call_abc');
    expect(msg.role).toBe('tool');
    expect(msg.tool_call_id).toBe('call_abc');
    expect(msg.content).toBe('{"price":68420}');
  });
});
