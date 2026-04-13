import { describe, it, expect } from 'vitest';
import {
  toAnthropicMessages,
  toAnthropicTools,
  fromAnthropicToolUse,
  toAnthropicToolResult,
  fromAnthropicResponse,
} from '../../kernel/capability/adapters/anthropic.mjs';

describe('Anthropic Adapter', () => {
  describe('toAnthropicMessages', () => {
    it('extracts system prompt into separate field', () => {
      const messages = [
        { role: 'system', content: 'You are a trader.' },
        { role: 'user', content: 'Hello' },
      ];
      const { system, messages: msgs } = toAnthropicMessages(messages);
      expect(system).toBe('You are a trader.');
      expect(msgs).toHaveLength(1);
      expect(msgs[0].role).toBe('user');
    });

    it('concatenates multiple system messages', () => {
      const messages = [
        { role: 'system', content: 'Part 1' },
        { role: 'system', content: 'Part 2' },
        { role: 'user', content: 'Hi' },
      ];
      const { system } = toAnthropicMessages(messages);
      expect(system).toContain('Part 1');
      expect(system).toContain('Part 2');
    });

    it('converts user messages to content blocks', () => {
      const { messages } = toAnthropicMessages([
        { role: 'user', content: 'Hello world' },
      ]);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content[0].type).toBe('text');
      expect(messages[0].content[0].text).toBe('Hello world');
    });

    it('converts assistant tool_calls to tool_use blocks', () => {
      const { messages } = toAnthropicMessages([
        {
          role: 'assistant',
          content: 'Let me check.',
          tool_calls: [{
            id: 'tc_1',
            type: 'function',
            function: { name: 'get_price', arguments: '{"symbol":"BTC"}' },
          }],
        },
      ]);
      expect(messages[0].content).toHaveLength(2);
      expect(messages[0].content[0].type).toBe('text');
      expect(messages[0].content[0].text).toBe('Let me check.');
      expect(messages[0].content[1].type).toBe('tool_use');
      expect(messages[0].content[1].name).toBe('get_price');
      expect(messages[0].content[1].input.symbol).toBe('BTC');
    });

    it('converts tool responses to tool_result in user message', () => {
      const { messages } = toAnthropicMessages([
        { role: 'tool', tool_call_id: 'tc_1', content: '{"price":68420}' },
      ]);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content[0].type).toBe('tool_result');
      expect(messages[0].content[0].tool_use_id).toBe('tc_1');
    });

    it('merges consecutive tool responses into one user message', () => {
      const { messages } = toAnthropicMessages([
        { role: 'tool', tool_call_id: 'tc_1', content: 'result1' },
        { role: 'tool', tool_call_id: 'tc_2', content: 'result2' },
      ]);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toHaveLength(2);
      expect(messages[0].content[0].tool_use_id).toBe('tc_1');
      expect(messages[0].content[1].tool_use_id).toBe('tc_2');
    });

    it('handles full conversation flow', () => {
      const messages = [
        { role: 'system', content: 'You are a trader.' },
        { role: 'user', content: 'Check BTC' },
        {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'get_price', arguments: '{"s":"BTC"}' } }],
        },
        { role: 'tool', tool_call_id: 'tc1', content: '68420' },
        { role: 'assistant', content: 'BTC is at $68,420' },
      ];

      const { system, messages: msgs } = toAnthropicMessages(messages);
      expect(system).toBe('You are a trader.');
      expect(msgs).toHaveLength(4); // user, assistant(tool_use), user(tool_result), assistant(text)
    });
  });

  describe('toAnthropicTools', () => {
    it('converts kernel capability schemas', () => {
      const tools = toAnthropicTools([{
        name: 'get_price',
        description: 'Get price',
        input_schema: { type: 'object', properties: { symbol: { type: 'string' } } },
        tags: [],
        mandate_check: false,
      }]);
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('get_price');
      expect(tools[0].description).toBe('Get price');
      expect(tools[0].input_schema.properties.symbol.type).toBe('string');
    });
  });

  describe('fromAnthropicToolUse', () => {
    it('converts tool_use block to kernel format', () => {
      const { name, input, call_id } = fromAnthropicToolUse({
        type: 'tool_use',
        id: 'toolu_abc',
        name: 'get_price',
        input: { symbol: 'BTC' },
      });
      expect(name).toBe('get_price');
      expect(input.symbol).toBe('BTC');
      expect(call_id).toBe('toolu_abc');
    });
  });

  describe('toAnthropicToolResult', () => {
    it('builds tool_result user message', () => {
      const msg = toAnthropicToolResult('get_price', '68420', 'toolu_abc');
      expect(msg.role).toBe('user');
      expect(msg.content[0].type).toBe('tool_result');
      expect(msg.content[0].tool_use_id).toBe('toolu_abc');
      expect(msg.content[0].content).toBe('68420');
    });
  });

  describe('fromAnthropicResponse', () => {
    it('extracts text content', () => {
      const { content, tool_calls } = fromAnthropicResponse({
        content: [{ type: 'text', text: 'Hello' }],
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: 'end_turn',
      });
      expect(content).toBe('Hello');
      expect(tool_calls).toHaveLength(0);
    });

    it('extracts tool_use as OpenAI-format tool_calls', () => {
      const { content, tool_calls, tokens } = fromAnthropicResponse({
        content: [
          { type: 'text', text: 'Checking...' },
          { type: 'tool_use', id: 'toolu_1', name: 'get_price', input: { symbol: 'BTC' } },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
        stop_reason: 'tool_use',
      });
      expect(content).toBe('Checking...');
      expect(tool_calls).toHaveLength(1);
      expect(tool_calls[0].id).toBe('toolu_1');
      expect(tool_calls[0].function.name).toBe('get_price');
      expect(JSON.parse(tool_calls[0].function.arguments)).toEqual({ symbol: 'BTC' });
      expect(tokens.total).toBe(150);
    });

    it('handles empty content', () => {
      const { content, tool_calls } = fromAnthropicResponse({ content: [], usage: {} });
      expect(content).toBeNull();
      expect(tool_calls).toHaveLength(0);
    });
  });
});
