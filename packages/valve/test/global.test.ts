// Shared concurrency, renewable slots, lifecycle cleanup, and wake notifications.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createValve, memoryStore } from '../src/index.js';
import { normalize } from '../src/rules.js';
import type { Store } from '../src/store.js';
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());
describe('global concurrency', () => {
  it.each([
    { limit: 0 },
    { limit: 1, scope: 'invalid' },
    { limit: 1, leaseTtl: '1s' },
    { limit: 1, scope: 'global', leaseTtl: 0 },
    null,
  ])('validates concurrency %j', (concurrency) => {
    expect(() => normalize({ id: 'bad', concurrency } as never)).toThrow();
  });
  it('rejects unsupported custom stores and fail-open global configuration', () => {
    const store = memoryStore();
    delete store.release;
    delete store.renew;
    expect(() =>
      createValve({
        id: 'bad',
        concurrency: { limit: 1, scope: 'global' },
        store,
      }),
    ).toThrow();
    expect(() =>
      createValve({
        id: 'bad',
        concurrency: { limit: 1, scope: 'global' },
        onStoreError: 'open',
      }),
    ).toThrow();
    expect(
      normalize({ id: 'local', concurrency: { limit: 2 } }).concurrency,
    ).toBe(2);
  });
  it('shares slots, renews long jobs, batches releases, and leaves no timers on close', async () => {
    vi.useFakeTimers();
    const store = memoryStore();
    const renew = vi.spyOn(store, 'renew');
    const valves = Array.from({ length: 4 }, () =>
      createValve({
        id: 'fleet',
        concurrency: { limit: 2, scope: 'global', leaseTtl: 90 },
        store,
      }),
    );
    let running = 0,
      peak = 0;
    const jobs = valves.flatMap((valve) =>
      Array.from({ length: 5 }, () =>
        valve.run(async () => {
          peak = Math.max(peak, ++running);
          await new Promise((resolve) => setTimeout(resolve, 120));
          running--;
        }),
      ),
    );
    await vi.advanceTimersByTimeAsync(1600);
    await Promise.all(jobs);
    expect(peak).toBe(2);
    expect(renew).toHaveBeenCalled();
    await Promise.all(valves.map((valve) => valve.close()));
    expect(vi.getTimerCount()).toBe(0);
  });
  it('expires abandoned slots without consuming a denied rate budget and never resurrects them', async () => {
    let now = 1000;
    const store = memoryStore({ clock: () => now });
    const rules = normalize({
      id: 'x',
      rate: { limit: 1, interval: 100, burst: 1 },
    }).rules;
    const first = store.acquireSync!({
      id: 'x',
      rules,
      costs: [1],
      lease: { limit: 1, ttlMs: 90, owner: 'first' },
    });
    expect(first.leases).toEqual(['first:0']);
    expect(
      store.acquireSync!({
        id: 'x',
        rules,
        costs: [1],
        lease: { limit: 1, ttlMs: 90, owner: 'second' },
      }).granted,
    ).toBe(0);
    now += 100;
    expect(await store.renew!('x', first.leases!, 90)).toBe(false);
    expect(
      store.acquireSync!({
        id: 'x',
        rules,
        costs: [1],
        lease: { limit: 1, ttlMs: 90, owner: 'next' },
      }).granted,
    ).toBe(1);
    await store.close();
  });
  it('rejects valves that share an id with different global limits', async () => {
    const store = memoryStore();
    const strict = createValve({
      id: 'x',
      concurrency: { limit: 1, scope: 'global' },
      store,
    });
    const loose = createValve({
      id: 'x',
      concurrency: { limit: 5, scope: 'global' },
      store,
    });
    expect(await strict.run(() => 1)).toBe(1);
    await expect(loose.run(() => 2)).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    });
    await Promise.all([strict.close(), loose.close()]);
  });
  it('checks static rules, lease limit, and lease TTL together', () => {
    const store = memoryStore();
    const rules = normalize({
      id: 'x',
      rate: { limit: 2, interval: 100 },
    }).rules;
    const lease = { limit: 2, ttlMs: 100, owner: 'a' };
    expect(
      store.acquireSync!({ id: 'x', rules, costs: [1], lease }).granted,
    ).toBe(1);
    // A separately normalized but identical policy shares the id.
    const equivalent = normalize({
      id: 'x',
      rate: { limit: 2, interval: 100 },
    }).rules;
    expect(() =>
      store.acquireSync!({
        id: 'x',
        rules: equivalent,
        costs: [1],
        lease: { ...lease, owner: 'b' },
      }),
    ).not.toThrow();
    for (const request of [
      { rules: [], lease },
      { rules, lease: { ...lease, limit: 3 } },
      { rules, lease: { ...lease, ttlMs: 200 } },
      { rules },
    ])
      expect(() =>
        store.acquireSync!({ id: 'x', costs: [1], ...request }),
      ).toThrow(/configuration does not match/);
  });
  it('retries after the lease TTL when more jobs than free slots ask an empty slot set', () => {
    const store = memoryStore({ clock: () => 1000 });
    expect(
      store.acquireSync!({
        id: 'x',
        rules: [],
        costs: [1, 1],
        lease: { limit: 1, ttlMs: 250, owner: 'o' },
      }),
    ).toEqual({
      granted: 1,
      retryAfterMs: 250,
      pausedMs: 0,
      leases: ['o:0'],
      leaseBlocked: true,
    });
  });
  it('forgets static policies once their rate and lease state expires', () => {
    let now = 0;
    const store = memoryStore({ clock: () => now });
    const rules = normalize({
      id: 'old',
      rate: { limit: 1, interval: 10 },
    }).rules;
    const changed = normalize({
      id: 'old',
      rate: { limit: 2, interval: 10 },
    }).rules;
    store.acquireSync!({ id: 'old', rules, costs: [1] });
    expect(() =>
      store.acquireSync!({ id: 'old', rules: changed, costs: [1] }),
    ).toThrow(/configuration does not match/);
    now = 1000;
    for (let i = 0; i < 1024; i++)
      store.acquireSync!({ id: `short-${i}`, rules, costs: [1] });
    expect(
      store.acquireSync!({ id: 'old', rules: changed, costs: [1] }).granted,
    ).toBe(1);
  });
  it('signals lease loss when renewal fails and releases on settlement', async () => {
    vi.useFakeTimers();
    const backing = memoryStore();
    const store: Store = {
      ...backing,
      renew: async () => {
        throw new Error('offline');
      },
    };
    const valve = createValve({
      id: 'loss',
      concurrency: { limit: 1, scope: 'global', leaseTtl: 90 },
      store,
    });
    let signal: AbortSignal | undefined;
    const job = valve.run(async (ctx) => {
      signal = ctx.signal;
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    const rejected = expect(job).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await vi.advanceTimersByTimeAsync(35);
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    await valve.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('renews a still-running job after its user signal aborts', async () => {
    vi.useFakeTimers();
    const store = memoryStore();
    const renew = vi.spyOn(store, 'renew');
    const controller = new AbortController();
    const valve = createValve({
      id: 'abort-running',
      concurrency: { limit: 1, scope: 'global', leaseTtl: 90 },
      store,
    });
    const job = valve.run(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
      },
      { signal: controller.signal },
    );
    await tick();
    controller.abort();
    await vi.advanceTimersByTimeAsync(250);
    await job;
    expect(renew.mock.calls.length).toBeGreaterThan(3);
    await valve.close();
  });
  it('releases grants cancelled while acquire was in flight', async () => {
    const backing = memoryStore();
    let finish!: () => void;
    const store: Store = {
      ...backing,
      acquire: async (request) => {
        const result = await backing.acquire(request);
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return result;
      },
    };
    delete store.acquireSync;
    const release = vi.spyOn(store, 'release');
    const valve = createValve({
      id: 'cancel-lease',
      concurrency: { limit: 1, scope: 'global' },
      store,
    });
    const job = valve.run(() => 42);
    const rejected = expect(job).rejects.toMatchObject({ code: 'CLOSED' });
    await tick();
    let closed = false;
    const closing = valve.close().then(() => {
      closed = true;
    });
    await rejected;
    await tick();
    expect(closed).toBe(false);
    finish();
    await closing;
    expect(release).toHaveBeenCalled();
  });
  it('stops waiting for an unanswered global admission after leaseTtl', async () => {
    vi.useFakeTimers();
    const backing = memoryStore();
    const store: Store = {
      ...backing,
      acquire: () => new Promise(() => {}),
    };
    delete store.acquireSync;
    const valve = createValve({
      id: 'hung-lease',
      concurrency: { limit: 1, scope: 'global', leaseTtl: 1000 },
      store,
    });
    const rejected = expect(valve.run(() => 42)).rejects.toMatchObject({
      code: 'CLOSED',
    });
    await tick();
    let closed = false;
    const closing = valve.close().then(() => {
      closed = true;
    });
    await rejected;
    await vi.advanceTimersByTimeAsync(999);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('wakes another valve immediately after shared resume', async () => {
    vi.useFakeTimers();
    const store = memoryStore();
    const first = createValve({ id: 'wake', concurrency: 1, store });
    const second = createValve({ id: 'wake', concurrency: 1, store });
    await first.pause(10000);
    const job = second.run(() => 42);
    await tick();
    expect(second.stats().queued).toBe(1);
    await first.resume();
    await tick();
    expect(await job).toBe(42);
    await first.close();
    await second.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('aborts at lease expiry even if renewal never answers', async () => {
    vi.useFakeTimers();
    const backing = memoryStore();
    const store: Store = { ...backing, renew: () => new Promise(() => {}) };
    const api = createValve({
      id: 'hung-renew',
      concurrency: { limit: 1, scope: 'global', leaseTtl: 90 },
      store,
    });
    let signal: AbortSignal | undefined;
    const job = api.run(async (ctx) => {
      signal = ctx.signal;
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    const rejected = expect(job).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await vi.advanceTimersByTimeAsync(95);
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    await api.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not restore a cached pause after a concurrent resume notification', async () => {
    const backing = memoryStore();
    let finish!: () => void;
    const store: Store = {
      ...backing,
      acquire: async (request) => {
        const result = await backing.acquire(request);
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return result;
      },
    };
    delete store.acquireSync;
    const valve = createValve({ id: 'resume-race', concurrency: 1, store });
    await backing.pause('resume-race', 10000);
    await tick();
    // Clear the local hint while leaving a pause in the backend, then acquire its old response.
    let notify!: Parameters<NonNullable<Store['subscribe']>>[1];
    const delayed: Store = {
      ...store,
      subscribe: (_id, listener) => {
        notify = listener;
        return () => {};
      },
    };
    const waiting = createValve({
      id: 'resume-race',
      concurrency: 1,
      store: delayed,
    });
    const job = waiting.run(() => 42);
    await tick();
    await backing.resume('resume-race');
    notify({ type: 'resume' });
    finish();
    await tick();
    finish();
    await tick();
    expect(await job).toBe(42);
    await waiting.close();
    await valve.close();
  });
  it('rechecks soon when release arrives during a denied acquire', async () => {
    vi.useFakeTimers();
    const backing = memoryStore();
    let notify!: Parameters<NonNullable<Store['subscribe']>>[1];
    let finish!: () => void;
    let calls = 0;
    const store: Store = {
      ...backing,
      subscribe: (_id, listener) => {
        notify = listener;
        return () => {};
      },
      acquire: async (request) => {
        if (++calls === 1) {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          return { granted: 0, retryAfterMs: 30000, pausedMs: 0 };
        }
        return backing.acquire(request);
      },
    };
    delete store.acquireSync;
    const valve = createValve({
      id: 'release-race',
      store,
      concurrency: { limit: 1, scope: 'global' },
    });
    const job = valve.run(() => 42);
    await tick();
    notify({ type: 'release' });
    await tick();
    finish();
    await tick();
    // The recheck waits a short jittered window instead of a 30s retry hint.
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toBe(2);
    expect(await job).toBe(42);
    await valve.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reports whether leases or rate rules denied an admission', () => {
    let now = 1000;
    const store = memoryStore({ clock: () => now });
    const rules = normalize({
      id: 'x',
      rate: { limit: 1, interval: 1000 },
    }).rules;
    const lease = { limit: 1, ttlMs: 500, owner: 'a' };
    expect(
      store.acquireSync!({ id: 'x', rules, costs: [1], lease }),
    ).toMatchObject({ granted: 1, leaseBlocked: false });
    expect(
      store.acquireSync!({ id: 'x', rules, costs: [1], lease }),
    ).toMatchObject({ granted: 0, leaseBlocked: true, retryAfterMs: 500 });
    now += 600;
    expect(
      store.acquireSync!({ id: 'x', rules, costs: [1], lease }),
    ).toMatchObject({ granted: 0, leaseBlocked: false, retryAfterMs: 400 });
    const scopedRules = normalize({
      id: 'y',
      rate: { name: 'r', scope: 'tenant', limit: 1, interval: 1000 },
    }).rules;
    const jobs = [
      { cost: 1, scopes: { tenant: 'a' } },
      { cost: 1, scopes: { tenant: 'a' } },
      { cost: 1, scopes: { tenant: 'b' } },
    ];
    expect(
      store.acquireScopedSync!({
        id: 'y',
        rules: scopedRules,
        jobs,
        lease: { limit: 1, ttlMs: 500, owner: 'b' },
      }).blocked,
    ).toEqual([
      { index: 1, retryAfterMs: 1000, leaseBlocked: false },
      { index: 2, retryAfterMs: 500, leaseBlocked: true },
    ]);
  });
  describe('store call budget', () => {
    /** Count admission calls while optionally hiding notifications to test fallback polling. */
    const counted = (base: Store, subscribe = true) => {
      const store: Store = {
        ...base,
        /** Record each admission before forwarding it to the backing store. */
        acquireSync: (request) => {
          calls.count++;
          return base.acquireSync!(request);
        },
      };
      if (!subscribe) delete store.subscribe;
      const calls = { count: 0 };
      return { store, calls };
    };
    it.each([true, false])(
      'follows the rate hint for a rate-blocked global valve (subscriber=%s)',
      async (subscribe) => {
        vi.useFakeTimers();
        const { store, calls } = counted(memoryStore(), subscribe);
        const valve = createValve({
          id: 'rate-wait',
          concurrency: { limit: 4, scope: 'global' },
          rate: { limit: 1, interval: '2s' },
          store,
        });
        const jobs = [valve.run(() => 1), valve.run(() => 2)];
        await vi.advanceTimersByTimeAsync(1000);
        expect(calls.count).toBeLessThanOrEqual(2);
        await vi.advanceTimersByTimeAsync(1100);
        expect(await Promise.all(jobs)).toEqual([1, 2]);
        expect(calls.count).toBeLessThanOrEqual(3);
        await valve.close();
      },
    );
    it.each([
      { subscribe: false, random: 0, expectedCalls: 21 },
      // A 71ms interval puts the next poll 65ms after release at t=1000.
      { subscribe: false, random: 0.84, expectedCalls: 15 },
      { subscribe: false, random: 1 - Number.EPSILON, expectedCalls: 14 },
      { subscribe: true, random: 0, expectedCalls: 2 },
      { subscribe: true, random: 1 - Number.EPSILON, expectedCalls: 1 },
    ])(
      'bounds lease polling and wakes after release (subscriber=$subscribe, random=$random)',
      async ({ subscribe, random, expectedCalls }) => {
        vi.useFakeTimers();
        const jitter = vi.spyOn(Math, 'random').mockReturnValue(random);
        try {
          const { store, calls } = counted(memoryStore(), subscribe);
          const options = {
            id: 'lease-wait',
            concurrency: {
              limit: 1,
              scope: 'global' as const,
              leaseTtl: 10000,
            },
            store,
          };
          const holder = createValve(options);
          const valve = createValve(options);
          let release!: () => void;
          const held = holder.run(
            () => new Promise<void>((r) => (release = r)),
          );
          await vi.advanceTimersByTimeAsync(0);
          calls.count = 0;
          const waiting = valve.run(() => 2);
          await vi.advanceTimersByTimeAsync(1000);
          expect(calls.count).toBe(expectedCalls);
          release();
          await held;
          // Fallback polling adds up to 25ms of jitter to its 50ms delay.
          await vi.advanceTimersByTimeAsync(75);
          expect(valve.stats().totals.started).toBe(1);
          expect(await waiting).toBe(2);
          await Promise.all([holder.close(), valve.close()]);
        } finally {
          jitter.mockRestore();
        }
      },
    );
    it('keeps release fan-out well below one admission per waiting valve', async () => {
      vi.useFakeTimers();
      const { store, calls } = counted(memoryStore());
      const valves = Array.from({ length: 30 }, () =>
        createValve({
          id: 'fan-out',
          concurrency: { limit: 1, scope: 'global' },
          store,
        }),
      );
      const done = Promise.all(
        Array.from({ length: 60 }, (_, i) =>
          valves[i % valves.length]!.run(
            () => new Promise((resolve) => setTimeout(resolve, 5)),
          ),
        ),
      );
      await vi.advanceTimersByTimeAsync(5000);
      await done;
      // Every waiting valve used to answer each release: about 16 per job.
      expect(calls.count / 60).toBeLessThan(10);
      await Promise.all(valves.map((valve) => valve.close()));
    });
    it('wakes scoped lease waits after a release without polling rate-only waits', async () => {
      vi.useFakeTimers();
      const { store, calls } = counted(memoryStore());
      const acquire = store.acquireScopedSync!;
      store.acquireScopedSync = (request) => {
        calls.count++;
        return acquire(request);
      };
      const options = {
        id: 'scoped-release',
        concurrency: { limit: 1, scope: 'global' as const },
        rate: {
          name: 'recipient',
          scope: 'recipient',
          limit: 1,
          interval: 2000,
        },
        store,
      };
      const holder = createValve(options);
      const waiter = createValve(options);
      let release!: () => void;
      const held = holder.run(() => new Promise<void>((r) => (release = r)), {
        scopes: { recipient: 'A' },
      });
      await vi.advanceTimersByTimeAsync(0);
      const waiting = waiter.run(() => 'B', { scopes: { recipient: 'B' } });
      await vi.advanceTimersByTimeAsync(0);
      release();
      await held;
      await vi.advanceTimersByTimeAsync(60);
      expect(waiter.stats().totals.started).toBe(1);
      expect(await waiting).toBe('B');
      const rateWait = waiter.run(() => 'B again', {
        scopes: { recipient: 'B' },
      });
      await vi.advanceTimersByTimeAsync(0);
      const before = calls.count;
      await store.release!(options.id, []);
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls.count).toBe(before);
      await vi.advanceTimersByTimeAsync(1100);
      expect(await rateWait).toBe('B again');
      await Promise.all([holder.close(), waiter.close()]);
    });
    it('continues scoped global jobs after a fully granted batch releases its slots', async () => {
      vi.useFakeTimers();
      const api = createValve({
        id: 'scoped-batches',
        concurrency: { limit: 1, scope: 'global' },
        rate: {
          name: 'recipient',
          scope: 'recipient',
          limit: 1,
          interval: '2s',
        },
      });
      const jobs = ['A', 'B', 'C'].map((recipient) =>
        api.run(() => recipient, { scopes: { recipient } }),
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(api.stats().totals.succeeded).toBe(3);
      expect(await Promise.all(jobs)).toEqual(['A', 'B', 'C']);
      await api.close();
    });
    it('does not let aborts bypass store outage backoff', async () => {
      vi.useFakeTimers();
      let failures = 0;
      const base = memoryStore();
      const store: Store = {
        ...base,
        /** Simulate an outage and count attempts that should respect the backoff deadline. */
        acquire: () => {
          failures++;
          return Promise.reject(new Error('down'));
        },
      };
      delete store.acquireSync;
      const valve = createValve({
        id: 'outage',
        concurrency: { limit: 1, scope: 'global' },
        store,
      });
      const controllers = Array.from(
        { length: 5 },
        () => new AbortController(),
      );
      const jobs = controllers.map((controller) =>
        valve.run(() => 1, { signal: controller.signal }).catch((e) => e.code),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(failures).toBe(1);
      for (const controller of controllers.slice(0, 4)) {
        controller.abort();
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(failures).toBe(1);
      await vi.advanceTimersByTimeAsync(150);
      expect(failures).toBe(2);
      controllers[4]!.abort();
      expect(await Promise.all(jobs)).toEqual(Array(5).fill('ABORTED'));
      await valve.close();
    });
  });
});
