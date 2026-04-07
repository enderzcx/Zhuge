/**
 * Agent LLM wrapper — streaming + non-streaming + fallback.
 * OpenAI-compatible API. Supports tool_calls in responses.
 *
 * Usage:
 *   const { chat, chatStream } = createAgentLLM(config, { log, metrics });
 *   const result = await chat(messages, { model, tools, max_tokens });
 *   for await (const chunk of chatStream(messages, opts)) { ... }
 */

import { startChildSpan, endSpan } from './observe/tracing.mjs';
import { context } from '@opentelemetry/api';

const DEFAULT_TIMEOUT = 60000;
const DEFAULT_MAX_TOKENS = 1200;
const DEFAULT_TEMP = 0.3;
const FALLBACK_MODEL = 'gpt-5.4-mini';

export function createAgentLLM(config, { log, metrics } = {}) {
  const _log = log || { info() {}, warn() {}, error() {} };
  const _m = metrics || { record() {} };

  /**
   * Non-streaming chat completion. Returns full message with tool_calls.
   */
  async function chat(messages, opts = {}) {
    const model = opts.model || config.LLM_MODEL;
    const start = Date.now();
    const { span } = startChildSpan(context.active(), 'llm:chat', { model });

    const body = {
      model,
      messages,
      max_tokens: opts.max_tokens || DEFAULT_MAX_TOKENS,
      temperature: opts.temperature ?? DEFAULT_TEMP,
    };
    if (opts.tools?.length) {
      body.tools = opts.tools;
      body.tool_choice = opts.tool_choice || 'auto';
    }

    try {
      const res = await fetch(`${config.LLM_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.LLM_KEY}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeout || DEFAULT_TIMEOUT),
      });

      if (!res.ok) {
        const status = res.status;
        // Fallback on 402/429/5xx if not already using fallback model
        if ((status === 402 || status === 429 || status >= 500) && model !== FALLBACK_MODEL) {
          _log.warn('llm_fallback', { module: 'agent-llm', from: model, to: FALLBACK_MODEL, status });
          return chat(messages, { ...opts, model: FALLBACK_MODEL });
        }
        throw new Error(`LLM ${status}`);
      }

      const data = await res.json();
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error('No message in LLM response');

      const usage = data.usage || {};
      const elapsed = Date.now() - start;

      _m.record('llm_latency_ms', elapsed, { module: 'agent', model });
      _m.record('llm_tokens_in', usage.prompt_tokens || 0, { module: 'agent', model });
      _m.record('llm_tokens_out', usage.completion_tokens || 0, { module: 'agent', model });

      span.setAttribute('tokens_in', usage.prompt_tokens || 0);
      span.setAttribute('tokens_out', usage.completion_tokens || 0);
      endSpan(span);

      return {
        message: msg,
        content: msg.content || '',
        tool_calls: msg.tool_calls || [],
        model: data.model || model,
        tokens: {
          input: usage.prompt_tokens || 0,
          output: usage.completion_tokens || 0,
          total: usage.total_tokens || 0,
        },
        duration_ms: elapsed,
      };
    } catch (err) {
      endSpan(span, err);
      _m.record('error_count', 1, { module: 'agent-llm', type: 'chat' });
      _log.error('llm_chat_error', { module: 'agent-llm', model, error: err.message });
      throw err;
    }
  }

  /**
   * Streaming chat completion. Yields text chunks as they arrive.
   * Final yield includes { done: true, content, tool_calls, tokens }.
   *
   * Note: Many OpenAI-compatible APIs return tool_calls in non-streaming
   * even when stream=true. We handle both cases.
   */
  async function* chatStream(messages, opts = {}) {
    const model = opts.model || config.LLM_MODEL;
    const start = Date.now();
    const { span: streamSpan } = startChildSpan(context.active(), 'llm:stream', { model });

    const body = {
      model,
      messages,
      max_tokens: opts.max_tokens || DEFAULT_MAX_TOKENS,
      temperature: opts.temperature ?? DEFAULT_TEMP,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (opts.tools?.length) {
      body.tools = opts.tools;
      body.tool_choice = opts.tool_choice || 'auto';
    }

    const abortCtrl = new AbortController();
    const timeoutId = setTimeout(() => abortCtrl.abort(), opts.timeout || DEFAULT_TIMEOUT);

    let res;
    try {
      res = await fetch(`${config.LLM_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.LLM_KEY}`,
        },
        body: JSON.stringify(body),
        signal: abortCtrl.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      // Timeout or network error — fallback to non-streaming
      _log.warn('stream_fallback_to_chat', { module: 'agent-llm', error: err.message });
      const result = await chat(messages, { ...opts, model });
      endSpan(streamSpan);
      yield { done: true, ...result };
      return;
    }

    if (!res.ok) {
      clearTimeout(timeoutId);
      // Fallback model on payment/rate/server errors
      if ((res.status === 402 || res.status === 429 || res.status >= 500) && model !== FALLBACK_MODEL) {
        _log.warn('stream_fallback_model', { module: 'agent-llm', from: model, to: FALLBACK_MODEL, status: res.status });
        endSpan(streamSpan);
        yield* chatStream(messages, { ...opts, model: FALLBACK_MODEL });
        return;
      }
      throw new Error(`LLM stream ${res.status}`);
    }

    // Check if response is actually streamed (SSE) or plain JSON
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      // API returned non-streamed response despite stream:true
      const data = await res.json();
      const msg = data.choices?.[0]?.message;
      const usage = data.usage || {};
      const elapsed = Date.now() - start;
      _m.record('llm_latency_ms', elapsed, { module: 'agent', model });
      endSpan(streamSpan);
      yield {
        done: true,
        message: msg,
        content: msg?.content || '',
        tool_calls: msg?.tool_calls || [],
        model: data.model || model,
        tokens: { input: usage.prompt_tokens || 0, output: usage.completion_tokens || 0, total: usage.total_tokens || 0 },
        duration_ms: elapsed,
      };
      return;
    }

    // Parse SSE stream
    let fullContent = '';
    const toolCallsMap = {}; // index → { id, name, arguments }
    let streamUsage = { input: 0, output: 0, total: 0 };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    function processLine(line) {
      if (!line.startsWith('data: ')) return;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') return;

      let chunk;
      try { chunk = JSON.parse(payload); } catch { return; }

      const delta = chunk.choices?.[0]?.delta;

      // Text content
      if (delta?.content) {
        fullContent += delta.content;
        // Cannot yield from inner function — handled via return value
      }

      // Tool calls (streamed incrementally)
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCallsMap[idx]) {
            toolCallsMap[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          }
          if (tc.id) toolCallsMap[idx].id = tc.id;
          // Overwrite name (not append) to avoid doubling from some providers
          if (tc.function?.name) toolCallsMap[idx].function.name = tc.function.name;
          if (tc.function?.arguments) toolCallsMap[idx].function.arguments += tc.function.arguments;
        }
      }

      // Usage in final chunk (requires stream_options.include_usage)
      if (chunk.usage) {
        streamUsage = {
          input: chunk.usage.prompt_tokens || 0,
          output: chunk.usage.completion_tokens || 0,
          total: chunk.usage.total_tokens || 0,
        };
      }

      return delta?.content || null;
    }

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const text = processLine(line);
          if (text) yield { text };
        }
      }
      // Flush remaining buffer
      if (buffer.trim()) {
        const text = processLine(buffer);
        if (text) yield { text };
      }
    } finally {
      clearTimeout(timeoutId);
      reader.releaseLock();
      abortCtrl.abort(); // cleanup: abort fetch if consumer breaks early
    }

    const elapsed = Date.now() - start;
    _m.record('llm_latency_ms', elapsed, { module: 'agent', model });
    if (streamUsage.input) _m.record('llm_tokens_in', streamUsage.input, { module: 'agent', model });
    if (streamUsage.output) _m.record('llm_tokens_out', streamUsage.output, { module: 'agent', model });

    const toolCalls = Object.values(toolCallsMap);
    const message = { role: 'assistant', content: fullContent || null };
    if (toolCalls.length) message.tool_calls = toolCalls;

    endSpan(streamSpan);
    yield {
      done: true,
      message,
      content: fullContent,
      tool_calls: toolCalls,
      model,
      tokens: streamUsage,
      duration_ms: elapsed,
    };
  }

  return { chat, chatStream };
}
