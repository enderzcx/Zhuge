/**
 * Generic agent runner: LLM with tool-calling loop.
 */

export function createAgentRunner({ config, db, messageBus }) {
  const { insertDecision } = db;

  const agentMetrics = {}; // { analyst: { calls: 0, errors: 0, total_ms: 0, total_tokens: 0, last_run: null } }

  function recordMetric(agent, durationMs, tokens, error = false) {
    if (!agentMetrics[agent]) agentMetrics[agent] = { calls: 0, errors: 0, total_ms: 0, total_tokens: 0, last_run: null };
    const m = agentMetrics[agent];
    m.calls++;
    if (error) m.errors++;
    m.total_ms += durationMs;
    m.total_tokens += tokens;
    m.last_run = new Date().toISOString();
  }

  /**
   * Run an agent: LLM with tool-calling loop.
   * @param {string} agentName - e.g. 'analyst', 'risk', 'strategist', 'reviewer'
   * @param {string} systemPrompt
   * @param {{ type: string, function: { name: string, description: string, parameters: object } }[]} agentTools - OpenAI tool defs
   * @param {Record<string, (args: object) => Promise<string>>} toolExecutors - { toolName: fn(args) => resultString }
   * @param {string} userMessage
   * @param {{ trace_id?: string, max_rounds?: number, max_tokens?: number, model?: string, timeout?: number, trade_id?: string }} opts
   * @returns {Promise<{ content: string, toolCalls: { name: string, args: object, result: string }[], trace_id: string }>}
   */
  async function runAgent(agentName, systemPrompt, agentTools, toolExecutors, userMessage, opts = {}) {
    const traceId = opts.trace_id || `${agentName}_${Date.now()}`;
    const maxRounds = opts.max_rounds || 5;
    const agentStart = Date.now();
    let totalTokens = 0;
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];
    const allToolCalls = [];

    const agentModel = opts.model || config.AGENT_MODELS[agentName] || config.LLM_MODEL;

    try {
    for (let round = 0; round < maxRounds; round++) {
      const reqBody = {
        model: agentModel,
        messages,
        max_tokens: opts.max_tokens || 800,
        temperature: 0.3,
      };
      if (agentTools.length > 0) {
        reqBody.tools = agentTools;
        reqBody.tool_choice = 'auto';
      }

      const start = Date.now();
      const _doFetch = async (attempt = 0) => {
        const r = await fetch(`${config.LLM_BASE}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.LLM_KEY}` },
          body: JSON.stringify(reqBody),
          signal: AbortSignal.timeout(opts.timeout || 30000),
        });
        if ((r.status === 402 || r.status === 429) && attempt < 2) {
          await new Promise(ok => setTimeout(ok, 3000 * (attempt + 1)));
          return _doFetch(attempt + 1);
        }
        return r;
      };
      const res = await _doFetch();
      if (!res.ok) throw new Error(`LLM ${res.status}`);
      const data = await res.json();
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error('No message in LLM response');
      totalTokens += data.usage?.total_tokens || 0;

      messages.push(msg);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);

      // No tool calls → done
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        const totalMs = Date.now() - agentStart;
        console.log(`[Agent:${agentName}] Done in ${round + 1} round(s), ${elapsed}s, ${totalTokens}tok [${agentModel}]`);
        recordMetric(agentName, totalMs, totalTokens);
        return { content: msg.content || '', toolCalls: allToolCalls, trace_id: traceId };
      }

      // Execute tool calls
      for (const tc of msg.tool_calls) {
        const fnName = tc.function.name;
        const args = JSON.parse(tc.function.arguments || '{}');
        const executor = toolExecutors[fnName];
        let result;
        if (executor) {
          try { result = await executor(args); } catch (e) { result = JSON.stringify({ error: e.message }); }
        } else {
          result = JSON.stringify({ error: `Unknown tool: ${fnName}` });
        }

        allToolCalls.push({ name: fnName, args, result });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: typeof result === 'string' ? result : JSON.stringify(result) });

        // Record to decisions table
        try {
          insertDecision.run(
            new Date().toISOString(), agentName, 'tool_call',
            fnName, JSON.stringify(args), typeof result === 'string' ? result : JSON.stringify(result),
            '', '', '', 0, opts.trade_id || null
          );
        } catch {}
      }
    }

    // Max rounds reached
    const lastContent = messages[messages.length - 1]?.content || '';
    recordMetric(agentName, Date.now() - agentStart, totalTokens);
    return { content: lastContent, toolCalls: allToolCalls, trace_id: traceId };

    } catch (err) {
      recordMetric(agentName, Date.now() - agentStart, totalTokens, true);
      throw err;
    }
  }

  return { runAgent, agentMetrics, recordMetric };
}
