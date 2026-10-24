// Regression counterexamples from the second independent review.
import { getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { memoryStore } from '../src/index.js';
import { createValveGroup } from '../src/group/index.js';
import type { ValveGroup, ValveGroupKeyOptions } from '../src/group/index.js';
import type { RunOptions } from '../src/types.js';

const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((done) => (release = done));
  return { promise, release };
};
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const outcome = (promise: Promise<unknown>) =>
  promise.catch((error: { code?: string }) => error.code);

// An idle globally limited child can still be waiting for its final lease release.
const blockedRoom = async (keyOptions: ValveGroupKeyOptions = {}) => {
  const store = memoryStore();
  const release = store.release!.bind(store);
  const gate = deferred();
  store.release = async (...args) => {
    await gate.promise;
    return release(...args);
  };
  const group = createValveGroup({
    id: 'review-r2',
    store,
    maxSize: 1,
    resolve: () => ({
      concurrency: { limit: 1, scope: 'global' },
      ...keyOptions,
    }),
  });
  await group.run('a', () => 1);
  // x evicts a, whose close is held; with maxSize 1 closing, new keys must wait.
  await group.run('x', () => 0);
  return {
    group,
    gate,
    cleanup: async () => {
      gate.release();
      await group.close();
      await store.close();
    },
  };
};

describe('round 2 counterexamples', () => {
  it('R2-1: keeps the resolver guard while reading returned option getters', async () => {
    const store = memoryStore();
    const subscribe = store.subscribe!.bind(store);
    let live = 0;
    store.subscribe = (id, listener) => {
      live++;
      const off = subscribe(id, listener) as () => void;
      return () => {
        live--;
        off();
      };
    };
    let entered = false;
    let nested: Promise<unknown> | undefined;
    const g: ValveGroup = createValveGroup({
      id: 'getter-reentry',
      maxSize: 1,
      store,
      resolve: () => ({
        get concurrency() {
          if (!entered) {
            entered = true;
            nested = outcome(g.run('k', () => 'nested'));
          }
          return 1;
        },
      }),
    });
    try {
      await g.run('k', () => 'outer');
      const result = await nested;
      await g.close();
      expect({ result, live }).toEqual({ result: 'INVALID_OPTIONS', live: 0 });
    } finally {
      await g.close();
      await store.close();
    }
  });

  it('R2-2: expires the key default maxWait before room becomes available', async () => {
    const { group, cleanup } = await blockedRoom({ maxWait: 10 });
    try {
      let state: unknown = 'pending';
      const waiting = outcome(group.run('b', () => 'ran')).then((value) => {
        state = value;
      });
      await sleep(40);
      expect(state).toBe('MAX_WAIT_EXCEEDED');
      await cleanup();
      await waiting;
    } finally {
      await cleanup();
    }
  });

  it('R2-3: inherits a Request signal when init exists without a signal', async () => {
    const { group, cleanup } = await blockedRoom();
    try {
      const controller = new AbortController();
      const request = new Request('https://example.test/', {
        signal: controller.signal,
      });
      const impl = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
      let state: unknown = 'pending';
      const waiting = outcome(
        group.get('b').wrapFetch(impl)(request, { headers: { 'x-test': '1' } }),
      ).then((value) => {
        state = value;
      });
      controller.abort('cancel');
      await sleep(20);
      expect(state).toBe('ABORTED');
      await cleanup();
      await waiting;
    } finally {
      await cleanup();
    }
  });

  it('R2-4: removes a slow-path abort listener when maxWait validation rejects', async () => {
    const { group, cleanup } = await blockedRoom();
    try {
      const controller = new AbortController();
      let waiting!: Promise<unknown>;
      expect(() => {
        waiting = group.run('b', () => 1, {
          maxWait: -1,
          signal: controller.signal,
        });
      }).not.toThrow();
      await expect(waiting).rejects.toMatchObject({
        code: 'INVALID_OPTIONS',
        valveId: group.get('b').id,
      });
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it('R2-5: retains the child id on invalid per-run maxWait errors', async () => {
    const g = createValveGroup({
      id: 'invalid-wait',
      resolve: () => ({ concurrency: 1 }),
    });
    try {
      await expect(g.run('k', () => 1, { maxWait: -1 })).rejects.toMatchObject({
        code: 'INVALID_OPTIONS',
        valveId: g.get('k').id,
      });
    } finally {
      await g.close();
    }
  });

  it('R2-6: honors durations longer than the platform timer maximum', async () => {
    vi.useFakeTimers();
    const { group, cleanup } = await blockedRoom();
    try {
      const limit = 2147483647 + 10000;
      let state: unknown = 'pending';
      const waiting = outcome(
        group.run('b', () => 'ran', { maxWait: limit }),
      ).then((value) => {
        state = value;
      });
      await vi.advanceTimersByTimeAsync(2147483647);
      expect(state).toBe('pending');
      await cleanup();
      await waiting;
    } finally {
      await cleanup();
      vi.useRealTimers();
    }
  });

  it('R2-7: reads maxWait from the creation snapshot instead of re-reading a getter', async () => {
    const store = memoryStore();
    const subscribe = store.subscribe!.bind(store);
    let live = 0;
    store.subscribe = (id, listener) => {
      live++;
      const off = subscribe(id, listener) as () => void;
      return () => {
        live--;
        off();
      };
    };
    let reads = 0;
    const g = createValveGroup({
      id: 'getter-snapshot',
      store,
      resolve: () => ({
        concurrency: 1,
        get maxWait() {
          if (++reads === 1) return 100;
          throw new Error('maxWait getter was read twice');
        },
      }),
    });
    try {
      const result = await g
        .run('k', () => 'ran')
        .catch((e: Error) => e.message);
      await g.close();
      expect({ result, reads, live }).toEqual({
        result: 'ran',
        reads: 1,
        live: 0,
      });
    } finally {
      await g.close();
      await store.close();
    }
  });

  it('R2-8: removes canceled acquisitions instead of resolving their keys later', async () => {
    const store = memoryStore();
    const release = store.release!.bind(store);
    const gate = deferred();
    store.release = async (...args) => {
      await gate.promise;
      return release(...args);
    };
    const resolve = vi.fn(() => ({
      concurrency: { limit: 1, scope: 'global' as const },
    }));
    const g = createValveGroup({
      id: 'canceled-acquisitions',
      store,
      maxSize: 1,
      resolve,
    });
    try {
      await g.run('a', () => 1);
      // Fill the only live slot, so maxSize (1) closes are in flight and new keys wait.
      await g.run('x', () => 0);
      const controller = new AbortController();
      const canceled = Array.from({ length: 200 }, (_, i) =>
        outcome(
          g.run(`abandoned-${i}`, () => 1, { signal: controller.signal }),
        ),
      );
      controller.abort();
      expect(await Promise.all(canceled)).toEqual(Array(200).fill('ABORTED'));
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      // Resolving early reads the default maxWait; cancellation must prevent
      // construction and any later resolver call when room opens.
      const resolved = resolve.mock.calls.length;
      gate.release();
      await sleep(20);
      expect(resolve.mock.calls).toHaveLength(resolved);
      expect(g.stats()).toEqual({ size: 1, active: 0 });
    } finally {
      gate.release();
      await g.close();
      await store.close();
    }
  });

  it('bounds all waiting calls, including repeated calls for one key', async () => {
    const store = memoryStore();
    const release = store.release!.bind(store);
    const gate = deferred();
    store.release = async (...args) => {
      await gate.promise;
      return release(...args);
    };
    const g = createValveGroup({
      id: 'pending-bound',
      store,
      maxSize: 1,
      maxPending: 2,
      resolve: () => ({ concurrency: { limit: 1, scope: 'global' } }),
    });
    try {
      await g.run('a', () => 1);
      // Fill the only live slot, so maxSize (1) closes are in flight and new keys wait.
      await g.run('x', () => 0);
      const controller = new AbortController();
      const first = outcome(g.run('b', () => 1, { signal: controller.signal }));
      const second = outcome(g.run('b', () => 2));
      for (const key of ['b', 'c'])
        await expect(g.run(key, () => 3)).rejects.toMatchObject({
          code: 'QUEUE_FULL',
        });
      controller.abort();
      expect(await first).toBe('ABORTED');
      const replacement = outcome(g.run('b', () => 4));
      gate.release();
      expect(await Promise.all([second, replacement])).toEqual([2, 4]);
      expect(g.stats()).toEqual({ size: 1, active: 0 });
    } finally {
      gate.release();
      await g.close();
      await store.close();
    }
  });

  it('R2-4b: never invokes a job after slow-path validation already rejected it', async () => {
    const { group, gate, cleanup } = await blockedRoom();
    const fn = vi.fn(() => 1);
    const options: RunOptions<number> = { maxWait: -1 };
    try {
      await expect(group.run('b', fn, options)).rejects.toMatchObject({
        code: 'INVALID_OPTIONS',
      });
      // Reusing options for a subsequent request must not revive a rejected job.
      options.maxWait = 1000;
      gate.release();
      await sleep(20);
      expect(fn).not.toHaveBeenCalled();
      expect(group.stats().active).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('R2-9: non-draining close cancels a grant whose job has not started', async () => {
    const g = createValveGroup({
      id: 'close-grant',
      resolve: () => ({ concurrency: 1 }),
    });
    const fn = vi.fn(() => 'ran-after-close');
    try {
      const waiting = outcome(g.run('k', fn));
      // Let admission run, but close before the separate invocation microtask.
      await Promise.resolve();
      expect(fn).not.toHaveBeenCalled();
      const closing = g.close();
      const result = await waiting;
      await closing;
      expect({ result, calls: fn.mock.calls.length }).toEqual({
        result: 'CLOSED',
        calls: 0,
      });
    } finally {
      await g.close();
    }
  });
});

describe('round 2 controls', () => {
  it('clears the guard after resolver and createValve errors', async () => {
    let attempt = 0;
    const g = createValveGroup({
      id: 'guard-recovery',
      resolve: () => {
        if (++attempt === 1) throw new Error('lookup');
        return { concurrency: attempt === 2 ? -1 : 1 };
      },
    });
    try {
      await expect(g.run('a', () => 1)).rejects.toThrow('lookup');
      await expect(g.run('a', () => 1)).rejects.toMatchObject({
        code: 'INVALID_OPTIONS',
      });
      await expect(g.run('a', () => 1)).resolves.toBe(1);
      expect(g.stats()).toEqual({ size: 1, active: 0 });
    } finally {
      await g.close();
    }
  });

  it('guards a resolver calling another group that calls back', async () => {
    let callback!: Promise<unknown>;
    let other!: Promise<unknown>;
    const g: ValveGroup = createValveGroup({
      id: 'indirect-g',
      resolve: () => {
        other = outcome(h.run('h', () => 2));
        return { concurrency: 1 };
      },
    });
    const h = createValveGroup({
      id: 'indirect-h',
      resolve: () => {
        callback = outcome(g.run('g', () => 3));
        return { concurrency: 1 };
      },
    });
    try {
      await expect(g.run('g', () => 1)).resolves.toBe(1);
      expect(await other).toBe(2);
      expect(await callback).toBe('INVALID_OPTIONS');
    } finally {
      await Promise.all([g.close(), h.close()]);
    }
  });

  it('releases all pins when abort races room arrival across many callers', async () => {
    const { group, gate, cleanup } = await blockedRoom();
    try {
      const controllers = Array.from(
        { length: 100 },
        () => new AbortController(),
      );
      const fn = vi.fn();
      const waiting = controllers.map((controller, i) =>
        outcome(
          group.run('b', fn, { signal: controller.signal, maxWait: 1000 + i }),
        ),
      );
      for (const controller of controllers.slice(0, 50))
        controller.abort('before');
      gate.release();
      await Promise.resolve();
      for (const controller of controllers.slice(50))
        controller.abort('arrival');
      expect(await Promise.all(waiting)).toEqual(Array(100).fill('ABORTED'));
      await sleep(10);
      expect(fn).not.toHaveBeenCalled();
      expect(group.stats().active).toBe(0);
      for (const controller of controllers)
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      await cleanup();
      expect(group.stats()).toEqual({ size: 0, active: 0 });
    } finally {
      await cleanup();
    }
  });

  it('handles ready rejecting after abort and close without leaked counters', async () => {
    const { group, gate, cleanup } = await blockedRoom();
    try {
      const controller = new AbortController();
      const waiting = outcome(
        group.run('b', () => 1, { signal: controller.signal }),
      );
      controller.abort('cancel');
      expect(await waiting).toBe('ABORTED');
      const closing = group.close();
      expect(group.close()).toBe(closing);
      gate.release();
      await closing;
      await sleep(0);
      expect(group.stats()).toEqual({ size: 0, active: 0 });
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it('uses child ids and abort causes on valid slow-path failures', async () => {
    const { group, cleanup } = await blockedRoom();
    try {
      const controller = new AbortController();
      const reason = new Error('cancel');
      const waiting = group.run('b', () => 1, { signal: controller.signal });
      controller.abort(reason);
      await expect(waiting).rejects.toMatchObject({
        code: 'ABORTED',
        valveId: group.get('b').id,
        cause: reason,
        message: 'valve("review-r2:b"): job was aborted before starting.',
      });
      await expect(
        group.run('c', () => 1, { maxWait: 1 }),
      ).rejects.toMatchObject({
        code: 'MAX_WAIT_EXCEEDED',
        valveId: group.get('c').id,
      });
    } finally {
      await cleanup();
    }
  });

  it('rejects invalid duration values asynchronously on fast and slow paths', async () => {
    const { group, cleanup } = await blockedRoom();
    try {
      for (const maxWait of [
        -1,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        'invalid' as const,
      ]) {
        let promise!: Promise<unknown>;
        expect(() => {
          promise = group.run('b', () => 1, { maxWait: maxWait as number });
        }).not.toThrow();
        await expect(promise).rejects.toMatchObject({
          code: 'INVALID_OPTIONS',
        });
      }
      expect(group.stats().active).toBe(0);
    } finally {
      await cleanup();
    }
  });
});
