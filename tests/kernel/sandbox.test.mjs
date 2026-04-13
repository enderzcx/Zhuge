import { describe, it, expect } from 'vitest';
import { createSandbox } from '../../kernel/sandbox/index.mjs';

describe('Sandbox', () => {
  it('runs handler in-process by default', async () => {
    const sandbox = createSandbox();
    const result = await sandbox.run('in-process', async (input) => `hello ${input.name}`, { name: 'world' });
    expect(result).toBe('hello world');
  });

  it('times out long-running handlers', async () => {
    const sandbox = createSandbox();
    await expect(
      sandbox.run('in-process', async () => new Promise(r => setTimeout(r, 5000)), {}, { timeout_ms: 50 })
    ).rejects.toThrow('timeout');
  });

  it('throws on unknown backend', async () => {
    const sandbox = createSandbox();
    await expect(
      sandbox.run('wasi', async () => {}, {})
    ).rejects.toThrow('Unknown sandbox backend');
  });

  it('lists available backends', () => {
    const sandbox = createSandbox();
    expect(sandbox.listBackends()).toContain('in-process');
  });

  it('registers custom backend', async () => {
    const sandbox = createSandbox();
    sandbox.registerBackend('custom', {
      run: async (handler, input) => {
        const result = await handler(input);
        return `custom:${result}`;
      },
    });
    expect(sandbox.listBackends()).toContain('custom');
    const result = await sandbox.run('custom', async () => 'test', {});
    expect(result).toBe('custom:test');
  });

  it('rejects invalid backend registration', () => {
    const sandbox = createSandbox();
    expect(() => sandbox.registerBackend('bad', {})).toThrow('run');
  });
});
