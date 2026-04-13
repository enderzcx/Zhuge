import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createCapabilityRegistry } from '../../../kernel/capability/registry.mjs';
import { createCapabilityGateway } from '../../../kernel/capability/gateway.mjs';
import { createEventStore } from '../../../kernel/event-store/index.mjs';
import { createMandateGate } from '../../../kernel/mandate/gate.mjs';
import { registerAllTraderCapabilities } from '../../../harness/trader/capabilities/register-all.mjs';
import { createKernelToolAdapter } from '../../../harness/trader/capabilities/adapter.mjs';

/** Create mock tool modules with TOOL_DEFS + EXECUTORS. */
function createMockToolModules() {
  return {
    dataTools: {
      TOOL_DEFS: [
        { name: 'price', description: 'Get price', parameters: { type: 'object', properties: { symbol: { type: 'string' } } }, requiresConfirmation: false },
        { name: 'status_report', description: 'System status', parameters: { type: 'object', properties: {} }, requiresConfirmation: false },
      ],
      EXECUTORS: {
        price: async (args) => JSON.stringify({ price: 68420, symbol: args.symbol || 'BTC' }),
        status_report: async () => JSON.stringify({ uptime: '24h', healthy: true }),
      },
    },
    tradeTools: {
      TOOL_DEFS: [
        { name: 'open_trade', description: 'Open a trade', parameters: { type: 'object', required: ['symbol', 'side'], properties: { symbol: { type: 'string' }, side: { type: 'string' } } }, requiresConfirmation: true, isDestructive: true },
        { name: 'close_trade', description: 'Close a trade', parameters: { type: 'object', properties: { trade_id: { type: 'string' } } }, requiresConfirmation: true, isDestructive: true },
        { name: 'positions', description: 'Get positions', parameters: { type: 'object', properties: {} }, requiresConfirmation: false },
        { name: 'balance', description: 'Get balance', parameters: { type: 'object', properties: {} }, requiresConfirmation: false },
      ],
      EXECUTORS: {
        open_trade: async (args) => JSON.stringify({ ok: true, trade_id: 'T001', symbol: args.symbol }),
        close_trade: async (args) => JSON.stringify({ ok: true, closed: args.trade_id }),
        positions: async () => JSON.stringify([]),
        balance: async () => JSON.stringify({ equity: 1000, available: 900 }),
      },
    },
    memoryTools: {
      TOOL_DEFS: [
        { name: 'save_memory', description: 'Save memory', parameters: { type: 'object', properties: { content: { type: 'string' } } }, requiresConfirmation: false },
        { name: 'read_memory', description: 'Read memory', parameters: { type: 'object', properties: {} }, requiresConfirmation: false },
      ],
      EXECUTORS: {
        save_memory: async (args) => JSON.stringify({ ok: true }),
        read_memory: async () => 'context: BTC bullish',
      },
    },
    scheduleTools: { TOOL_DEFS: [], EXECUTORS: {} },
    systemTools: { TOOL_DEFS: [], EXECUTORS: {} },
    tradingviewTools: { TOOL_DEFS: [], EXECUTORS: {} },
  };
}

describe('registerAllTraderCapabilities', () => {
  let registry;

  beforeEach(() => {
    registry = createCapabilityRegistry();
  });

  it('registers all tools with trader. prefix', () => {
    const modules = createMockToolModules();
    const count = registerAllTraderCapabilities(registry, modules);
    expect(count).toBe(8); // 2 data + 4 trade + 2 memory
    expect(registry.has('trader.price')).toBe(true);
    expect(registry.has('trader.open_trade')).toBe(true);
    expect(registry.has('trader.save_memory')).toBe(true);
  });

  it('sets mandate_check on trade tools', () => {
    const modules = createMockToolModules();
    registerAllTraderCapabilities(registry, modules);

    expect(registry.get('trader.open_trade').mandate_check).toBe(true);
    expect(registry.get('trader.close_trade').mandate_check).toBe(true);
    expect(registry.get('trader.price').mandate_check).toBe(false);
    expect(registry.get('trader.positions').mandate_check).toBe(false);
  });

  it('sets correct tags per category', () => {
    const modules = createMockToolModules();
    registerAllTraderCapabilities(registry, modules);

    const dataSchemas = registry.list({ tags: ['data'] });
    expect(dataSchemas.length).toBe(2);
    const tradeSchemas = registry.list({ tags: ['trade'] });
    expect(tradeSchemas.length).toBe(4);
  });

  it('handlers call original executors', async () => {
    const modules = createMockToolModules();
    registerAllTraderCapabilities(registry, modules);

    const priceCap = registry.get('trader.price');
    const result = await priceCap.handler({ symbol: 'ETH' });
    expect(JSON.parse(result).price).toBe(68420);
  });
});

describe('Gateway with mandate_check', () => {
  it('vetoes trader.open_trade when mandate fails', async () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    const eventStore = createEventStore({ db });
    const registry = createCapabilityRegistry();
    const mandateGate = createMandateGate();

    // Load a simple constraint
    mandateGate.load('trader', [{
      id: 'equity_check',
      when: { action: 'open_trade' },
      require: 'equity > 0',
      veto_message: 'no equity',
    }]);

    const modules = createMockToolModules();
    registerAllTraderCapabilities(registry, modules);

    const gateway = createCapabilityGateway({ registry, eventStore, mandateGate });

    // Should veto — equity is 0 in mandate context
    await expect(
      gateway.execute('trader.open_trade', { symbol: 'BTC', side: 'long' }, { mandate_context: { equity: 0 } })
    ).rejects.toThrow('Mandate VETO');

    // Should pass — equity > 0
    const result = await gateway.execute(
      'trader.open_trade',
      { symbol: 'BTC', side: 'long' },
      { mandate_context: { equity: 1000 } },
    );
    expect(JSON.parse(result).ok).toBe(true);
  });
});

describe('KernelToolAdapter', () => {
  let adapter;
  let gateway;
  let registry;

  beforeEach(() => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    const eventStore = createEventStore({ db });
    registry = createCapabilityRegistry();

    const modules = createMockToolModules();
    registerAllTraderCapabilities(registry, modules);

    gateway = createCapabilityGateway({ registry, eventStore });

    const oldExecutor = {
      execute: async (name, args) => `old:${name}`,
      getToolDefs: () => [{ type: 'function', function: { name: 'old_tool', description: 'old', parameters: {} } }],
    };
    const oldRegistry = {
      needsConfirmation: (name) => name === 'open_trade',
      describeAction: (name, args) => `execute ${name}`,
    };

    adapter = createKernelToolAdapter({ gateway, registry, oldExecutor, oldRegistry });
  });

  it('routes registered tools through kernel gateway', async () => {
    const result = await adapter.execute('price', { symbol: 'SOL' });
    expect(JSON.parse(result).price).toBe(68420);
  });

  it('falls back to old executor for unregistered tools', async () => {
    // 'old_tool' not in kernel registry
    const result = await adapter.execute('old_tool', {});
    expect(result).toBe('old:old_tool');
  });

  it('getToolDefs merges kernel + legacy, strips prefix', () => {
    const defs = adapter.getToolDefs();
    // 8 kernel + 1 old-only = 9
    expect(defs.length).toBe(9);
    // Kernel tools should NOT have trader. prefix
    const kernelDef = defs.find(d => d.function.name === 'price');
    expect(kernelDef).toBeDefined();
    // Legacy tool should also be present
    const legacyDef = defs.find(d => d.function.name === 'old_tool');
    expect(legacyDef).toBeDefined();
  });

  it('propagates mandate veto (does not fallback to old executor)', async () => {
    // Create a gateway with mandate gate that vetoes open_trade
    const db2 = new Database(':memory:');
    db2.pragma('journal_mode = WAL');
    const es2 = createEventStore({ db: db2 });
    const reg2 = createCapabilityRegistry();
    const mg2 = createMandateGate();
    mg2.load('trader', [{
      id: 'block_all', when: { action: 'open_trade' }, require: 'false', veto_message: 'blocked',
    }]);
    const modules = createMockToolModules();
    registerAllTraderCapabilities(reg2, modules);
    const gw2 = createCapabilityGateway({ registry: reg2, eventStore: es2, mandateGate: mg2 });

    const adapter2 = createKernelToolAdapter({
      gateway: gw2, registry: reg2,
      oldExecutor: { execute: async () => 'old-should-not-run', getToolDefs: () => [] },
      oldRegistry: { needsConfirmation: () => false, describeAction: () => '' },
    });

    // Should throw mandate veto, NOT fallback
    await expect(adapter2.execute('open_trade', { symbol: 'BTC', side: 'long' }))
      .rejects.toThrow('Mandate VETO');
  });

  it('delegates needsConfirmation to old registry', () => {
    expect(adapter.needsConfirmation('open_trade', {})).toBe(true);
    expect(adapter.needsConfirmation('price', {})).toBe(false);
  });
});
