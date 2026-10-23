// Group races from independent review: reentrancy, close ordering, waits, and ownership.
import { describe, expect, it, vi } from 'vitest';
import { memoryStore } from '../src/index.js';
import { createValveGroup } from '../src/group/index.js';
import type { ValveGroup, ValveGroupOptions } from '../src/group/index.js';

const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((done) => (release = done));
  return { promise, release };
};
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const outcome = (promise: Promise<unknown>) =>
  promise.catch((error: { code?: string }) => error.code);
const counted = () => {
  const store = memoryStore();
  const subscribe = store.subscribe!.bind(store);
  let live = 0;
  let peak = 0;
  store.subscribe = (id, listener) => {
    live++;
    peak = Math.max(peak, live);
    const off = subscribe(id, listener) as () => void;
    return () => {
      live--;
      off();
    };
  };
  return { store, counts: () => ({ live, peak }) };
};

describe('createValveGroup races', () => {
  it('R1: rejects same-key calls from the resolver without a second valve', async () => {
    const counter = counted();
    let nested: Promise<unknown> | undefined;
    let entered = false;
    const g: ValveGroup = createValveGroup({
      id: 'review-same',
      store: counter.store,
      maxSize: 1,
      resolve: () => {
        if (!entered) {
          entered = true;
          nested = g.run('k', () => 'nested');
        }
        return { concurrency: 1 };
      },
    });
    try {
      await g.run('k', () => 'outer');
      // The resolver may not use its own group; the nested call fails cleanly.
      await expect(nested).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
      await expect(g.run('k', () => 'later')).resolves.toBe('later');
      await g.close();
      expect(counter.counts()).toEqual({ live: 0, peak: 1 });
    } finally {
      await g.close();
      await counter.store.close();
    }
  });

  it('R1b: rejects other-key calls from the resolver within maxSize', async () => {
    const store = memoryStore();
    let nested: Promise<unknown> | undefined;
    const g: ValveGroup = createValveGroup({
      id: 'review-capacity',
      store,
      maxSize: 1,
      resolve: (key) => {
        if (key === 'outer') nested = outcome(g.run('inner', () => 'inner'));
        return { concurrency: 1 };
      },
    });
    try {
      const outer = g.run('outer', () => 'outer');
      const size = g.stats().size;
      const [, inner] = await Promise.all([outer, nested]);
      expect(inner).toBe('INVALID_OPTIONS');
      expect(size).toBeLessThanOrEqual(1);
    } finally {
      await g.close();
      await store.close();
    }
  });

  it('R2: does not publish a child after resolve calls close', async () => {
    const counter = counted();
    let closing: Promise<void> | undefined;
    const g: ValveGroup = createValveGroup({
      id: 'review-resolver-close',
      store: counter.store,
      resolve: () => {
        closing = g.close();
        return { concurrency: 1 };
      },
    });
    try {
      const result = await outcome(g.run('k', () => 'ran-after-close'));
      await closing;
      expect({ result, live: counter.counts().live }).toEqual({
        result: 'CLOSED',
        live: 0,
      });
    } finally {
      await g.close();
      await counter.store.close();
    }
  });

  it('R3: marks the group closed before child reject listeners run', async () => {
    const counter = counted();
    const gate = deferred();
    const started = deferred();
    const g = createValveGroup({
      id: 'review-listener-close',
      store: counter.store,
      resolve: () => ({ concurrency: 1 }),
    });
    const running = g.run('first', () => {
      started.release();
      return gate.promise;
    });
    await started.promise;
    const queued = outcome(g.run('first', () => 'queued'));
    let late: Promise<unknown> | undefined;
    g.on('reject', () => {
      late ??= outcome(g.run('late', () => 'ran-after-close'));
    });
    try {
      const closing = g.close();
      gate.release();
      await Promise.all([running, queued, closing]);
      const result = await late;
      expect({ result, live: counter.counts().live }).toEqual({
        result: 'CLOSED',
        live: 0,
      });
    } finally {
      gate.release();
      await g.close();
      await counter.store.close();
    }
  });

  it('R3b: returns the same close promise to reentrant close listeners', async () => {
    const gate = deferred();
    const started = deferred();
    const g = createValveGroup({
      id: 'review-idempotence',
      resolve: () => ({ concurrency: 1 }),
    });
    const running = g.run('k', () => {
      started.release();
      return gate.promise;
    });
    await started.promise;
    const queued = outcome(g.run('k', () => 1));
    let reentrant: Promise<void> | undefined;
    g.on('reject', () => {
      reentrant = g.close();
    });
    const closing = g.close();
    gate.release();
    await Promise.all([running, queued, closing, reentrant]);
    expect(reentrant).toBe(closing);
  });

  it('R3c: settles every close promise with an incomplete managed call', async () => {
    const store = memoryStore();
    const original = store.managed!.getLimits.bind(store.managed);
    const managedGate = deferred();
    const managedEntered = deferred();
    vi.spyOn(store.managed!, 'getLimits').mockImplementation(
      async (context) => {
        managedEntered.release();
        await managedGate.promise;
        return original(context);
      },
    );
    const runGate = deferred();
    const started = deferred();
    const g = createValveGroup({
      id: 'review-drained',
      store,
      resolve: () => ({
        concurrency: 1,
        limits: 'managed',
        rate: { name: 'r', limit: 100, burst: 100, interval: '1s' },
      }),
    });
    const running = g.run('k', () => {
      started.release();
      return runGate.promise;
    });
    await started.promise;
    const queued = outcome(g.run('k', () => 1));
    const managed = g.get('k').getLimits();
    await managedEntered.promise;
    const closed = { outer: false, reentrant: false };
    g.on('reject', () => {
      void g.close().then(() => {
        closed.reentrant = true;
      });
    });
    try {
      const closing = g.close().then(() => {
        closed.outer = true;
      });
      runGate.release();
      await Promise.all([running, queued]);
      await sleep(10);
      managedGate.release();
      await Promise.all([managed, closing]);
      await sleep(10);
      expect(closed).toEqual({ outer: true, reentrant: true });
    } finally {
      runGate.release();
      managedGate.release();
      await g.close();
      await store.close();
    }
  });

  it('R4: aborts a call while it waits for room', async () => {
    const store = memoryStore();
    const release = store.release!.bind(store);
    const gate = deferred();
    store.release = async (...args) => {
      await gate.promise;
      return release(...args);
    };
    const g = createValveGroup({
      id: 'review-abort',
      store,
      maxSize: 1,
      resolve: () => ({ concurrency: { limit: 1, scope: 'global' } }),
    });
    try {
      await g.run('a', () => 1);
      const controller = new AbortController();
      let state: unknown = 'pending';
      const waiting = outcome(
        g.run('b', () => 'ran', { signal: controller.signal }),
      ).then((value) => {
        state = value;
      });
      controller.abort();
      await sleep(30);
      const beforeRoom = state;
      gate.release();
      await waiting;
      expect(beforeRoom).toBe('ABORTED');
    } finally {
      gate.release();
      await g.close();
      await store.close();
    }
  });

  it('R4c: counts time waiting for room toward the key default maxWait', async () => {
    const store = memoryStore();
    const release = store.release!.bind(store);
    let gate = deferred();
    store.release = async (...args) => {
      await gate.promise;
      return release(...args);
    };
    const g = createValveGroup({
      id: 'review-default-maxwait',
      store,
      maxSize: 1,
      resolve: (key) => ({
        concurrency: { limit: 1, scope: 'global' },
        maxWait: key === 'short' ? 20 : 5000,
      }),
    });
    try {
      await g.run('a', () => 1);
      const short = outcome(g.run('short', () => 'ran-after-deadline'));
      await sleep(50);
      gate.release();
      expect(await short).toBe('MAX_WAIT_EXCEEDED');
      gate = deferred();
      await g.run('a', () => 1).catch(() => {});
      const long = g.run('long', () => 'long');
      await sleep(50);
      gate.release();
      await expect(long).resolves.toBe('long');
      expect(g.stats().active).toBe(0);
    } finally {
      gate.release();
      await g.close();
      await store.close();
    }
  });

  it('R4d: honors fetch signals while waiting for room', async () => {
    const store = memoryStore();
    const release = store.release!.bind(store);
    const gate = deferred();
    store.release = async (...args) => {
      await gate.promise;
      return release(...args);
    };
    const g = createValveGroup({
      id: 'review-fetch-abort',
      store,
      maxSize: 1,
      resolve: () => ({ concurrency: { limit: 1, scope: 'global' } }),
    });
    try {
      await g.run('a', () => 1);
      const controller = new AbortController();
      // Typed like fetch so wrapFetch reads the signal from init.
      const fetchImpl = (...args: [url: string, init?: RequestInit]) =>
        Promise.resolve({ status: args.length ? 200 : 500, headers: {} });
      const waiting = outcome(
        g.get('b').wrapFetch(fetchImpl)('x', { signal: controller.signal }),
      );
      const timed = outcome(
        g.get('c').wrapFetch(fetchImpl, { maxWait: 10 })('x'),
      );
      controller.abort();
      expect(await waiting).toBe('ABORTED');
      expect(await timed).toBe('MAX_WAIT_EXCEEDED');
      const aborted = new AbortController();
      aborted.abort();
      expect(
        await outcome(g.run('d', () => 1, { signal: aborted.signal })),
      ).toBe('ABORTED');
      gate.release();
      await expect(g.run('b', () => 'b')).resolves.toBe('b');
      expect(g.stats().active).toBe(0);
    } finally {
      gate.release();
      await g.close();
      await store.close();
    }
  });

  it('R4e: rejects a fetch whose wait for room used its whole maxWait', async () => {
    const store = memoryStore();
    const release = store.release!.bind(store);
    let gate = deferred();
    store.release = async (...args) => {
      await gate.promise;
      return release(...args);
    };
    const g = createValveGroup({
      id: 'review-fetch-deadline',
      store,
      maxSize: 1,
      resolve: (key) => ({
        concurrency: { limit: 1, scope: 'global' },
        maxWait: key === 'short' ? 20 : 5000,
      }),
    });
    const calls: string[] = [];
    const fetchImpl = (...args: [url: string, init?: RequestInit]) => {
      calls.push(args[0]);
      return Promise.resolve({ status: 200, headers: {} });
    };
    try {
      await g.run('a', () => 1);
      // The key's default maxWait is exhausted while waiting for room.
      const short = outcome(g.get('short').wrapFetch(fetchImpl)('short'));
      await sleep(50);
      gate.release();
      expect(await short).toBe('MAX_WAIT_EXCEEDED');
      gate = deferred();
      await g.run('a', () => 1).catch(() => {});
      // A wait shorter than maxWait leaves the call to run normally.
      const long = g.get('long').wrapFetch(fetchImpl, { maxWait: 2000 })(
        'long',
      );
      await sleep(50);
      gate.release();
      expect((await long).status).toBe(200);
      expect(calls).toEqual(['long']);
      expect(g.stats().active).toBe(0);
    } finally {
      gate.release();
      await g.close();
      await store.close();
    }
  });

  it('R4b: includes time waiting for room in maxWait', async () => {
    const store = memoryStore();
    const release = store.release!.bind(store);
    const gate = deferred();
    store.release = async (...args) => {
      await gate.promise;
      return release(...args);
    };
    const g = createValveGroup({
      id: 'review-maxwait',
      store,
      maxSize: 1,
      resolve: () => ({ concurrency: { limit: 1, scope: 'global' } }),
    });
    try {
      await g.run('a', () => 1);
      const waiting = outcome(
        g.run('b', () => 'ran-after-deadline', { maxWait: 10 }),
      );
      await sleep(50);
      gate.release();
      expect(await waiting).toBe('MAX_WAIT_EXCEEDED');
    } finally {
      gate.release();
      await g.close();
      await store.close();
    }
  });

  it('R5: isolates throwing group listeners like Valve.on', async () => {
    const g = createValveGroup({
      id: 'review-events',
      resolve: () => ({ concurrency: 1 }),
    });
    const later = vi.fn();
    const warning = vi.fn();
    g.on('idle', () => {
      throw new Error('listener bug');
    });
    g.on('idle', later);
    g.on('warning', warning);
    try {
      await g.run('k', () => 1);
      await sleep(0);
      expect(warning).toHaveBeenCalled();
      expect(later).toHaveBeenCalledTimes(1);
    } finally {
      await g.close();
    }
  });

  it('R6: retains store ownership decided at construction', async () => {
    const store = memoryStore();
    const close = vi.spyOn(store, 'close');
    const options: ValveGroupOptions = {
      id: 'review-ownership',
      store,
      resolve: () => ({ concurrency: 1 }),
    };
    const g = createValveGroup(options);
    await g.run('k', () => 1);
    delete options.store;
    await g.close();
    try {
      expect(close).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  });
});

describe('createValveGroup race controls', () => {
  it('C1: keeps delimiter, percent, Unicode and brace identities injective', async () => {
    const ids = new Set<string>();
    for (const id of ['a', 'a:b', 'a:', ':', '%3A', '😀']) {
      const g = createValveGroup({ id, resolve: () => ({ concurrency: 1 }) });
      try {
        for (const key of ['x', ':x', 'b:x', '%3A', '{x}', '😀', 'é', 'é']) {
          const child = g.get(key).id;
          expect(ids.has(child)).toBe(false);
          expect(child).not.toMatch(/[{}]/);
          ids.add(child);
        }
      } finally {
        await g.close();
      }
    }
    const g = createValveGroup({
      id: 'a',
      resolve: () => ({ concurrency: 1 }),
    });
    try {
      expect(g.get('x'.repeat(198)).id.length).toBe(200);
      expect(() => g.get('secret-'.repeat(30))).not.toThrow(/secret/);
      await expect(g.run('\ud800', () => 1)).rejects.toMatchObject({
        code: 'INVALID_OPTIONS',
      });
    } finally {
      await g.close();
    }
  });

  it('C2: survives competing wait chains and cleans rejected tails', async () => {
    const counter = counted();
    const release = counter.store.release!.bind(counter.store);
    const gate = deferred();
    let firstRelease = true;
    counter.store.release = async (...args) => {
      if (firstRelease) {
        firstRelease = false;
        await gate.promise;
      }
      return release(...args);
    };
    const g = createValveGroup({
      id: 'review-waits',
      store: counter.store,
      maxSize: 1,
      resolve: () => ({ concurrency: { limit: 1, scope: 'global' } }),
    });
    try {
      await g.run('a', () => 1);
      const order = new Map<string, number[]>();
      const jobs = Array.from({ length: 200 }, (_, i) => {
        const key = ['b', 'c', 'b', 'a', 'd'][i % 5]!;
        return g
          .run(key, () => {
            const list = order.get(key) ?? [];
            list.push(i);
            order.set(key, list);
          })
          .catch((error: { code: string }) =>
            expect(error.code).toBe('QUEUE_FULL'),
          );
      });
      gate.release();
      await Promise.all(jobs);
      for (const indices of order.values())
        expect(indices).toEqual([...indices].sort((a, b) => a - b));
      // A rejected tail must not poison the next acquisition of that key.
      for (const key of ['a', 'b', 'c', 'd'])
        await expect(g.run(key, () => key)).resolves.toBe(key);
      expect(g.stats().active).toBe(0);
      expect(counter.counts().peak).toBe(1);
      await g.close();
      expect(counter.counts().live).toBe(0);
    } finally {
      gate.release();
      await g.close();
      await counter.store.close();
    }
  });

  it('C3: pins incomplete managed calls against TTL and capacity eviction', async () => {
    const store = memoryStore();
    const original = store.managed!.getLimits.bind(store.managed);
    const gate = deferred();
    const entered = deferred();
    vi.spyOn(store.managed!, 'getLimits').mockImplementation(
      async (context) => {
        entered.release();
        await gate.promise;
        return original(context);
      },
    );
    const g = createValveGroup({
      id: 'review-managed-pin',
      store,
      maxSize: 1,
      idleTtl: 0,
      resolve: () => ({
        rate: { name: 'r', limit: 1, interval: '1s' },
        limits: 'managed',
      }),
    });
    try {
      const operation = g.get('a').getLimits();
      await entered.promise;
      await sleep(10);
      expect(g.stats()).toEqual({ size: 1, active: 1 });
      await expect(g.run('b', () => 1)).rejects.toMatchObject({
        code: 'QUEUE_FULL',
      });
      let closed = false;
      const closing = g.close().then(() => {
        closed = true;
      });
      await sleep(10);
      expect(closed).toBe(false);
      gate.release();
      await Promise.all([operation, closing]);
      expect(g.stats()).toEqual({ size: 0, active: 0 });
    } finally {
      gate.release();
      await g.close();
      await store.close();
    }
  });

  it('C4: pins wrapFetch through retries and releases synchronous failures', async () => {
    const gate = deferred();
    const retryStarted = deferred();
    let calls = 0;
    const g = createValveGroup({
      id: 'review-fetch-pin',
      maxSize: 1,
      idleTtl: 0,
      resolve: () => ({
        concurrency: 1,
        feedback: (response) =>
          response.status === 429 ? { pauseMs: 1 } : undefined,
      }),
    });
    const member = g.get('a');
    const limited = member.wrapFetch(
      async () => {
        if (++calls === 1) return { status: 429, headers: {} };
        retryStarted.release();
        await gate.promise;
        return { status: 200, headers: {} };
      },
      { retries: 1 },
    );
    try {
      const response = limited();
      await retryStarted.promise;
      await sleep(10);
      expect(g.stats()).toEqual({ size: 1, active: 1 });
      await expect(g.run('b', () => 1)).rejects.toMatchObject({
        code: 'QUEUE_FULL',
      });
      gate.release();
      expect((await response).status).toBe(200);
      await expect(member.pause(-1)).rejects.toMatchObject({
        code: 'INVALID_OPTIONS',
      });
      expect(g.stats().active).toBe(0);
      await expect(g.run('b', () => 'b')).resolves.toBe('b');
      await expect(member.run(() => 'retained')).resolves.toBe('retained');
    } finally {
      gate.release();
      await g.close();
    }
  });

  it('C5: closes during sweep eviction without reopening waiting keys', async () => {
    const counter = counted();
    const release = counter.store.release!.bind(counter.store);
    const gate = deferred();
    const releasing = deferred();
    counter.store.release = async (...args) => {
      releasing.release();
      await gate.promise;
      return release(...args);
    };
    const g = createValveGroup({
      id: 'review-sweep-close',
      store: counter.store,
      maxSize: 1,
      idleTtl: 0,
      resolve: () => ({ concurrency: { limit: 1, scope: 'global' } }),
    });
    try {
      await g.run('a', () => 1);
      await releasing.promise;
      await sleep(10);
      const waiting = Array.from({ length: 20 }, () =>
        outcome(g.run('a', () => 'reopened')),
      );
      const closing = g.close({ drain: true });
      gate.release();
      expect(await Promise.all(waiting)).toEqual(Array(20).fill('CLOSED'));
      await closing;
      expect(g.stats()).toEqual({ size: 0, active: 0 });
      expect(counter.counts()).toEqual({ live: 0, peak: 1 });
    } finally {
      gate.release();
      await g.close();
      await counter.store.close();
    }
  });
});
