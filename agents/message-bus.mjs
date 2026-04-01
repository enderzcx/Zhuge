/**
 * In-memory agent message bus with SQLite persistence.
 */

export function createMessageBus({ db }) {
  const insertAgentMsg = db.prepare(`
    INSERT INTO agent_messages (trace_id, from_agent, to_agent, type, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const agentMessages = []; // in-memory bus: { from, to, type, payload, trace_id, ts }

  function postMessage(from, to, type, payload, traceId) {
    const msg = { from, to, type, payload, trace_id: traceId, ts: Date.now() };
    agentMessages.push(msg);
    if (agentMessages.length > 500) agentMessages.splice(0, agentMessages.length - 500);
    try { insertAgentMsg.run(traceId, from, to, type, JSON.stringify(payload), new Date().toISOString()); } catch {}
    return msg;
  }

  function getMessages(to, traceId) {
    return agentMessages.filter(m => m.to === to && (!traceId || m.trace_id === traceId));
  }

  return { agentMessages, postMessage, getMessages };
}
