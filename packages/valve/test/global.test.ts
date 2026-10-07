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
        rules: [],
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
    await valve.close();
    await rejected;
    finish();
    await tick();
    expect(release).toHaveBeenCalled();
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
  it('rechecks immediately when release arrives during a denied acquire', async () => {
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
    expect(calls).toBe(2);
    expect(await job).toBe(42);
    await valve.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
