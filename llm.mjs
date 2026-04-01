/**
 * LLM call wrapper for OpenAI-compatible APIs.
 */

export function createLLM(config) {
  async function llm(messages, opts = {}) {
    const start = Date.now();
    const res = await fetch(`${config.LLM_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.LLM_KEY}` },
      body: JSON.stringify({
        model: opts.model || config.LLM_MODEL,
        messages,
        max_tokens: opts.max_tokens || 800,
        temperature: opts.temperature || 0.3,
      }),
      signal: AbortSignal.timeout(opts.timeout || 30000),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}`);
    const data = await res.json();
    const usage = data.usage || {};
    return {
      content: data.choices?.[0]?.message?.content || '',
      duration_s: Number(((Date.now() - start) / 1000).toFixed(1)),
      model: data.model || config.LLM_MODEL,
      tokens: { prompt: usage.prompt_tokens || 0, completion: usage.completion_tokens || 0, total: usage.total_tokens || 0 },
    };
  }

  return llm;
}
