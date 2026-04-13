/**
 * Kernel Sandbox — capability execution isolation layer.
 *
 * Sprint 3: interface only, all execution is in-process.
 * Future backends: subprocess, WASI, Docker container.
 *
 * The interface exists so capabilities can declare their isolation level
 * without changing implementation when backends are added later.
 */

/**
 * Create a Sandbox instance.
 * @returns {Sandbox}
 */
export function createSandbox() {
  const backends = new Map();

  // Register the default in-process backend
  backends.set('in-process', {
    name: 'in-process',
    run: async (handler, input, opts) => {
      // Direct execution — no isolation
      const timeout = opts?.timeout_ms || 300000;

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Sandbox timeout after ${timeout}ms`)), timeout)
      );

      return Promise.race([handler(input), timeoutPromise]);
    },
  });

  /**
   * Run a handler in the specified sandbox backend.
   * @param {string} backend - 'in-process' | 'subprocess' | 'wasi'
   * @param {function} handler
   * @param {object} input
   * @param {{ timeout_ms?: number }} [opts]
   * @returns {Promise<*>}
   */
  async function run(backend, handler, input, opts) {
    const impl = backends.get(backend || 'in-process');
    if (!impl) {
      throw new Error(`Unknown sandbox backend: ${backend}. Available: ${[...backends.keys()].join(', ')}`);
    }
    return impl.run(handler, input, opts);
  }

  /**
   * Register a new sandbox backend.
   * @param {string} name
   * @param {{ run: function }} impl
   */
  function registerBackend(name, impl) {
    if (!impl || typeof impl.run !== 'function') {
      throw new Error('Backend must have a run(handler, input, opts) method');
    }
    backends.set(name, { name, ...impl });
  }

  /**
   * List available backends.
   * @returns {string[]}
   */
  function listBackends() {
    return [...backends.keys()];
  }

  return { run, registerBackend, listBackends };
}
