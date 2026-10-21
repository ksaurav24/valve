// Cause-aware retries, banked spreading, and release-notice coalescing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createValve, memoryStore } from '../src/index.js';
import type { AcquireResult, RateRule, Store, Valve } from '../src/index.js';

let valves: Valve[] = [];
const make: typeof createValve = (options) => {
  const valve = createValve(options);
  valves.push(valve);
  return valve;
};
const tick = () => vi.advanceTimersByTimeAsync(0);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
});
afterEach(async () => {
  for (const valve of valves) void valve.close();
  await tick();
  valves = [];
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A single denial followed by grants; records actual retry times, not timer internals. */
function deniedOnce(denial: Partial<AcquireResult> = {}, responseMs = 0) {
  const calls: number[] = [];
  let notify!: Parameters<NonNullable<Store['subscribe']>>[1];
  const store: Store = {
    kind: 'custom',
    acquire: async (request) => {
      calls.push(Date.now());
      if (calls.length === 1) {
        if (responseMs)
          await new Promise((resolve) => setTimeout(resolve, responseMs));
        return { granted: 0, retryAfterMs: 10, pausedMs: 0, ...denial };
      }
      return {
        granted: request.costs.length,
        retryAfterMs: 0,
        pausedMs: 0,
        ...(request.lease
          ? {
              leases: request.costs.map(
                (_, i) => `${request.lease!.owner}:${i}`,
              ),
            }
          : {}),
      };
    },
    release: async () => undefined,
    renew: async () => true,
    subscribe: (_id, listener) => {
      notify = listener;
      return () => undefined;
    },
    pause: async () => undefined,
    resume: async () => undefined,
    close: async () => undefined,
  };
  return { store, calls, notify: () => notify };
}

describe('banked GCRA rate spreading', () => {
  it.each([
    { burst: 100, cost: 1, random: 0, expected: 10 },
    { burst: 100, cost: 1, random: 0.5, expected: 23 },
    { burst: 100, cost: 1, random: 1 - Number.EPSILON, expected: 35 },
    // 2ms/unit; one unit reserved for lateness. Only 4ms remains here.
    { burst: 4, cost: 1, random: 0.5, expected: 12 },
    { burst: 4, cost: 1, random: 1 - Number.EPSILON, expected: 14 },
    { burst: 4, cost: 3, random: 0.9, expected: 10 },
  ])(
    'bounds spreading by bank and cost: %j',
    async ({ burst, cost, random, expected }) => {
      vi.spyOn(Math, 'random').mockReturnValue(random);
      const { store, calls } = deniedOnce();
      const valve = make({
        id: 'bank',
        rate: { limit: 500, interval: 1000, burst },
        store,
      });
      const job = valve.run(() => Date.now(), { cost });
      await vi.runAllTimersAsync();
      expect(await job).toBe(expected);
      expect(calls).toEqual([0, expected]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each<RateRule | RateRule[]>([
    { limit: 500, interval: 1000, burst: 1 },
    { algorithm: 'fixed-window', limit: 500, interval: 1000, burst: 100 },
    [
      { limit: 500, interval: 1000, burst: 100 },
      { algorithm: 'fixed-window', limit: 10, interval: 100 },
    ],
    [
      { limit: 500, interval: 1000, burst: 100 },
      { limit: 10, interval: 100, burst: 1 },
    ],
  ])('does not spread strict or fixed-window policies: %j', async (rate) => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const { store, calls } = deniedOnce();
    const valve = make({ id: 'unchanged', rate, store });
    const job = valve.run(() => Date.now());
    await vi.runAllTimersAsync();
    expect(await job).toBe(10);
    expect(calls).toEqual([0, 10]);
    expect(random).not.toHaveBeenCalled();
  });

  it('uses the smallest bank across simultaneous GCRA rules', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { store } = deniedOnce();
    const valve = make({
      id: 'multi',
      store,
      rate: [
        { limit: 500, interval: 1000, burst: 100 },
        { limit: 100, interval: 1000, burst: 3, name: 'tight' },
      ],
    });
    const job = valve.run(() => Date.now());
    await vi.runAllTimersAsync();
    expect(await job).toBe(15); // (3 - cost 1 - lateness 1) * 10ms / 2
  });

  it.each([0, 1])(
    'leaves synchronous and scoped scheduling unchanged (scoped=%i)',
    async (scoped) => {
      const random = vi.spyOn(Math, 'random').mockReturnValue(0.9);
      const store = memoryStore();
      if (scoped) {
        delete store.acquireSync;
        delete store.acquireScopedSync;
      }
      const valve = make({
        id: 'other-paths',
        store,
        rate: {
          limit: 500,
          interval: 1000,
          burst: 10,
          ...(scoped ? { name: 'tenant', scope: 'tenant' } : {}),
        },
      });
      const jobs = Array.from({ length: 12 }, () =>
        valve.run(() => Date.now(), scoped ? { scopes: { tenant: 'a' } } : {}),
      );
      await vi.runAllTimersAsync();
      expect((await Promise.all(jobs)).at(-1)).toBe(4);
      expect(random).not.toHaveBeenCalled();
    },
  );

  it.each([12, 20, 100])(
    'caps the uniform window before the earliest queued deadline %ims',
    async (deadline) => {
      vi.spyOn(Math, 'random').mockReturnValue(1 - Number.EPSILON);
      const { store } = deniedOnce();
      const valve = make({
        id: 'deadline',
        store,
        batch: 1,
        rate: { limit: 500, interval: 1000, burst: 100 },
      });
      // The deadline belongs to a lower priority job outside the denied batch.
      const a = valve.run(() => Date.now(), { priority: 10 });
      const b = valve.run(() => Date.now(), { maxWait: deadline });
      await vi.runAllTimersAsync();
      expect(await a).toBe(Math.max(10, Math.min(35, deadline - 5)));
      expect(await b).toBeLessThan(deadline);
    },
  );

  it('preempts an armed spread for a newly queued urgent job', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const { store, calls } = deniedOnce();
    const valve = make({
      id: 'urgent',
      store,
      rate: { limit: 500, interval: 1000, burst: 100 },
    });
    const order: string[] = [];
    const a = valve.run(() => order.push('backlog'));
    await tick();
    await vi.advanceTimersByTimeAsync(5);
    const b = valve.run(
      () => {
        order.push('urgent');
        return Date.now();
      },
      { priority: 10, maxWait: 15 },
    );
    await vi.runAllTimersAsync();
    expect(await b).toBe(10);
    await a;
    expect(order).toEqual(['urgent', 'backlog']);
    expect(calls).toEqual([0, 10]);
  });

  it('preserves the single immediate attempt for zero wait and rejects expired work', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const { store, calls } = deniedOnce();
    const valve = make({
      id: 'zero',
      store,
      rate: { limit: 500, interval: 1000, burst: 100 },
    });
    const fn = vi.fn();
    const job = Promise.allSettled([valve.run(fn, { maxWait: 0 })]);
    await vi.runAllTimersAsync();
    expect(await job).toMatchObject([
      { status: 'rejected', reason: { code: 'MAX_WAIT_EXCEEDED' } },
    ]);
    expect(calls).toEqual([0]);
    expect(fn).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
  });

  it('cancels during spreading without invoking the job or leaving timers', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const { store, calls } = deniedOnce();
    const valve = make({
      id: 'cancel',
      store,
      rate: { limit: 500, interval: 1000, burst: 100 },
    });
    const controller = new AbortController();
    const fn = vi.fn();
    const job = Promise.allSettled([
      valve.run(fn, { signal: controller.signal }),
    ]);
    await tick();
    controller.abort();
    await vi.runAllTimersAsync();
    expect(await job).toMatchObject([
      { status: 'rejected', reason: { code: 'ABORTED' } },
    ]);
    expect(fn).not.toHaveBeenCalled();
    expect(calls).toEqual([0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('finishes every worker without exceeding a shared banked rate or lease bound', async () => {
    let seed = 123;
    vi.spyOn(Math, 'random').mockImplementation(
      () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646,
    );
    const store = memoryStore();
    delete store.acquireSync;
    const times: number[] = [];
    let running = 0,
      peak = 0;
    const workers = Array.from({ length: 8 }, () =>
      make({
        id: 'fleet',
        store,
        rate: { limit: 100, interval: 1000, burst: 10 },
        concurrency: { limit: 4, scope: 'global' },
      }),
    );
    const jobs = workers.map((worker) =>
      Promise.all(
        Array.from({ length: 10 }, () =>
          worker.run(async () => {
            times.push(Date.now());
            peak = Math.max(peak, ++running);
            await new Promise((resolve) => setTimeout(resolve, 2));
            running--;
          }),
        ),
      ),
    );
    await vi.runAllTimersAsync();
    await Promise.all(jobs);
    let tat = 0;
    for (const time of times) {
      expect(Math.max(tat, time) + 10 - 100).toBeLessThanOrEqual(time);
      tat = Math.max(tat, time) + 10;
    }
    expect(times).toHaveLength(80);
    expect(peak).toBeLessThanOrEqual(4);
    expect(
      workers.every((worker) => worker.stats().totals.started === 10),
    ).toBe(true);
  });
});

describe('combined rate and lease retry causes', () => {
  it.each([false, true])(
    'compensates rate reply latency without lease jitter (subscriber=%s)',
    async (subscriber) => {
      const random = vi.spyOn(Math, 'random').mockReturnValue(0.99);
      const { store, calls, notify } = deniedOnce({ leaseBlocked: false }, 4);
      if (!subscriber) delete store.subscribe;
      const valve = make({
        id: 'combined',
        store,
        rate: { limit: 100, interval: 1000 },
        concurrency: { limit: 2, scope: 'global' },
      });
      const job = valve.run(() => Date.now());
      await vi.advanceTimersByTimeAsync(5);
      if (subscriber) notify()({ type: 'release' });
      await vi.advanceTimersByTimeAsync(4);
      expect(calls).toEqual([0]);
      await vi.advanceTimersByTimeAsync(1);
      expect(await job).toBe(10);
      expect(random).not.toHaveBeenCalled();
    },
  );

  it('keeps at least a 1ms retry when elapsed time exceeds the rate hint', async () => {
    const { store, calls } = deniedOnce({ leaseBlocked: false }, 20);
    const valve = make({
      id: 'minimum',
      store,
      rate: { limit: 100, interval: 1000 },
      concurrency: { limit: 2, scope: 'global' },
    });
    const job = valve.run(() => Date.now());
    await vi.advanceTimersByTimeAsync(21);
    expect(await job).toBe(21);
    expect(calls).toEqual([0, 21]);
  });

  it.each([true, undefined])(
    'retains lease polling and jitter for cause %s',
    async (leaseBlocked) => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const { store, calls } = deniedOnce({
        retryAfterMs: 2000,
        ...(leaseBlocked === undefined ? {} : { leaseBlocked }),
      });
      delete store.subscribe;
      const valve = make({
        id: 'lease-cause',
        store,
        rate: { limit: 500, interval: 1000, burst: 100 },
        concurrency: { limit: 2, scope: 'global' },
      });
      const job = valve.run(() => Date.now());
      await vi.advanceTimersByTimeAsync(63);
      expect(await job).toBe(63); // 50ms fallback + 12.5ms jitter, rounded up
      expect(calls).toEqual([0, 63]);
    },
  );
});

describe('release notification coalescing', () => {
  it('reconsiders a scoped in-flight denial after local release completion', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const base = memoryStore();
    delete base.acquireScopedSync;
    let answer!: () => void;
    const acquireScoped = vi.fn<NonNullable<Store['acquireScoped']>>(
      async (request) => {
        const result = await base.acquireScoped!(request);
        if (acquireScoped.mock.calls.length === 2)
          await new Promise<void>((resolve) => (answer = resolve));
        return result;
      },
    );
    const valve = make({
      id: 'scoped-stale',
      store: { ...base, acquireScoped },
      rate: { name: 'tenant', scope: 'tenant', limit: 1000, interval: 1 },
      concurrency: { limit: 2, scope: 'global', leaseTtl: 10000 },
    });
    let end!: () => void;
    const first = valve.run(
      () => new Promise<void>((resolve) => (end = resolve)),
      { scopes: { tenant: 'a' } },
    );
    await tick();
    const foreign = await base.acquireScoped!({
      id: 'scoped-stale',
      rules: acquireScoped.mock.calls[0]![0].rules,
      jobs: [{ cost: 1, scopes: { tenant: 'b' } }],
      lease: { limit: 2, ttlMs: 10000, owner: 'foreign' },
    });
    const second = valve.run(() => Date.now(), {
      scopes: { tenant: 'a' },
      maxWait: 100,
    });
    await tick();
    expect(acquireScoped).toHaveBeenCalledTimes(2);
    end();
    await first;
    await tick();
    answer();
    await vi.advanceTimersByTimeAsync(1);
    expect(await second).toBe(1);
    expect(acquireScoped).toHaveBeenCalledTimes(3);
    await base.release!(
      'scoped-stale',
      foreign.leases!.map((entry) => entry.token),
    );
  });
  it.each([false, true])(
    'rechecks a stale lease denial after local release (previous rate wait=%s)',
    async (rateWait) => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      let storeNow = 0;
      const base = memoryStore({ clock: () => storeNow });
      delete base.acquireSync;
      let answer!: () => void;
      const acquire = vi.fn<Store['acquire']>(async (request) => {
        const result = await base.acquire(request);
        if (acquire.mock.calls.length === 2)
          await new Promise<void>((resolve) => (answer = resolve));
        return result;
      });
      const store: Store = { ...base, acquire };
      const valve = make({
        id: 'stale-release',
        store,
        ...(rateWait ? { rate: { limit: 100, interval: 1000 } } : {}),
        concurrency: { limit: 2, scope: 'global', leaseTtl: 10000 },
      });
      let end!: () => void;
      const first = valve.run(
        () => new Promise<void>((resolve) => (end = resolve)),
      );
      const runSecond = () => valve.run(() => Date.now(), { maxWait: 100 });
      const early = rateWait ? runSecond() : undefined;
      await tick();
      if (rateWait) storeNow = 10;
      const foreign = await base.acquire({
        id: 'stale-release',
        rules: acquire.mock.calls[0]![0].rules,
        costs: [1],
        lease: { limit: 2, ttlMs: 10000, owner: 'foreign' },
      });
      const second = early ?? runSecond();
      await vi.advanceTimersByTimeAsync(rateWait ? 10 : 0);
      expect(acquire).toHaveBeenCalledTimes(2);
      end();
      await first;
      await tick(); // local release and its wake complete while acquire is in flight
      if (rateWait) storeNow = 20;
      answer();
      await vi.advanceTimersByTimeAsync(1);
      expect(await second).toBe(rateWait ? 11 : 1);
      expect(acquire).toHaveBeenCalledTimes(3);
      await base.release!('stale-release', foreign.leases!);
    },
  );
  it.each([false, true])(
    'coalesces echoes/duplicates during local release and wakes on completion (failure=%s)',
    async (fail) => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const base = memoryStore();
      delete base.acquireSync;
      let notify!: Parameters<NonNullable<Store['subscribe']>>[1];
      let finish!: () => void;
      const release = base.release!;
      const store: Store = {
        ...base,
        subscribe: (_id, listener) => {
          notify = listener;
          return () => undefined;
        },
        release: async (id, tokens) => {
          await release(id, tokens);
          notify({ type: 'release' });
          notify({ type: 'release' });
          await new Promise<void>((resolve) => (finish = resolve));
          if (fail) throw new Error('release reply lost');
        },
      };
      const acquire = vi.spyOn(store, 'acquire');
      const valve = make({
        id: 'echo',
        store,
        concurrency: { limit: 2, scope: 'global', leaseTtl: 10000 },
      });
      let end!: () => void;
      const first = valve.run(
        () => new Promise<void>((resolve) => (end = resolve)),
      );
      await tick();
      // Fill the other shared slot externally so the valve has queued work.
      const foreign = await base.acquire({
        id: 'echo',
        rules: [],
        costs: [1],
        lease: { limit: 2, ttlMs: 10000, owner: 'foreign' },
      });
      const second = valve.run(() => 'next');
      await tick();
      expect(acquire).toHaveBeenCalledTimes(2);
      end();
      await first;
      await tick();
      // A concurrent foreign notice is also covered by the pending completion.
      notify({ type: 'release' });
      await vi.advanceTimersByTimeAsync(20);
      expect(acquire).toHaveBeenCalledTimes(2);
      finish();
      await tick();
      expect(await second).toBe('next');
      expect(acquire).toHaveBeenCalledTimes(3);
      // Finish the second local release before checking a later foreign release.
      await tick();
      finish();
      await tick();
      const third = valve.run(() => 'foreign');
      // Hold both slots externally after the next job has started and settled.
      await third;
      await tick();
      finish();
      await tick();
      await release('echo', foreign.leases!);
      expect(valve.stats().totals.started).toBe(3);
    },
  );

  it.each(['drop', 'duplicate', 'restored-delivery'] as const)(
    'preserves foreign progress after a local release with %s messages',
    async (mode) => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const base = memoryStore();
      delete base.acquireSync;
      let notify!: Parameters<NonNullable<Store['subscribe']>>[1];
      const store: Store = {
        ...base,
        subscribe: (_id, listener) => {
          notify = listener;
          return () => undefined;
        },
      };
      const acquire = vi.spyOn(store, 'acquire');
      const valve = make({
        id: 'foreign',
        store,
        concurrency: { limit: 1, scope: 'global', leaseTtl: 10000 },
      });
      await valve.run(() => 'local release with dropped echo');
      await tick();
      const foreign = await base.acquire({
        id: 'foreign',
        rules: [],
        costs: [1],
        lease: { limit: 1, ttlMs: 10000, owner: 'foreign' },
      });
      expect(foreign.granted).toBe(1);
      const job = valve.run(() => Date.now());
      await tick();
      await vi.advanceTimersByTimeAsync(10);
      await base.release!('foreign', foreign.leases!);
      if (mode !== 'drop') {
        notify({ type: 'release' });
        if (mode === 'duplicate') notify({ type: 'release' });
      }
      await vi.advanceTimersByTimeAsync(mode === 'drop' ? 1000 : 5);
      expect(await job).toBe(mode === 'drop' ? 1000 : 11);
      expect(acquire).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
