// Scheduler timing, concurrency, batching, cancellation, shutdown, and policies.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createValve, memoryStore } from '../src/index.js';
import type { AcquireResult, Store, Valve } from '../src/index.js';
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
});
afterEach(async () => {
  for (const valve of valves) void valve.close();
  await tick();
  valves = [];
  vi.useRealTimers();
});
const failing = (acquire: Store['acquire']): Store => ({
  kind: 'custom',
  acquire,
  pause: () => Promise.resolve(),
  resume: () => Promise.resolve(),
  close: vi.fn(() => Promise.resolve()),
});

describe('queue and execution', () => {
  it('coalesces jobs, batches, infers sync and async results, and never invokes inline', async () => {
    const store = memoryStore();
    const spy = vi.spyOn(store, 'acquireSync');
    const valve = make({ id: 'x', concurrency: 2, store, batch: 2 });
    const fn = vi.fn(() => 42);
    const a = valve.run(fn);
    const b = valve.run(async () => 'b');
    expect(fn).not.toHaveBeenCalled();
    await tick();
    expect(await a).toBe(42);
    expect(await b).toBe('b');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].costs).toHaveLength(2);
    expect(valve.stats().totals.succeeded).toBe(2);
  });
  it('orders priorities and ties with local concurrency', async () => {
    const valve = make({ id: 'x', concurrency: 1 });
    const order: number[] = [];
    const tasks = [0, 1, 2, 3].map((n) =>
      valve.run(
        () => {
          order.push(n);
        },
        { priority: n === 2 ? 10 : 0 },
      ),
    );
    await tick();
    await Promise.all(tasks);
    expect(order).toEqual([2, 0, 1, 3]);
  });
  it('keeps call order for equal priorities when a batch is denied and requeued', async () => {
    const store = memoryStore();
    const acquire = store.acquireSync!;
    let denials = 2;
    store.acquireSync = (request) =>
      denials-- > 0
        ? { granted: 0, retryAfterMs: 10, pausedMs: 0 }
        : acquire(request);
    const valve = make({
      id: 'requeue',
      rate: { limit: 1, interval: 10 },
      store,
      batch: 4,
    });
    const order: number[] = [];
    const tasks = Array.from({ length: 10 }, (_, i) =>
      valve.run(() => order.push(i)),
    );
    await vi.runAllTimersAsync();
    await Promise.all(tasks);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
  it('enforces the local concurrency limit for asynchronous jobs', async () => {
    const valve = make({ id: 'x', concurrency: 2 });
    let running = 0;
    let peak = 0;
    const tasks = Array.from({ length: 5 }, () =>
      valve.run(
        () =>
          new Promise((resolve) => {
            peak = Math.max(peak, ++running);
            setTimeout(() => {
              running--;
              resolve(undefined);
            }, 10);
          }),
      ),
    );
    await vi.runAllTimersAsync();
    await Promise.all(tasks);
    expect(peak).toBe(2);
  });
  it('holds one store call in flight while new jobs arrive', async () => {
    let resolve!: (value: AcquireResult) => void;
    const acquire = vi.fn(
      () =>
        new Promise<AcquireResult>((r) => {
          resolve = r;
        }),
    );
    const valve = make({
      id: 'x',
      rate: { limit: 100, interval: 1, burst: 100 },
      store: failing(acquire),
    });
    const a = valve.run(() => 'a');
    await tick();
    const b = valve.run(() => 'b');
    await tick();
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(valve.stats().queued).toBe(2);
    resolve({ granted: 1, retryAfterMs: 0, pausedMs: 0 });
    await tick();
    expect(await a).toBe('a');
    expect(acquire).toHaveBeenCalledTimes(2);
    resolve({ granted: 1, retryAfterMs: 0, pausedMs: 0 });
    await tick();
    expect(await b).toBe('b');
  });
  it('spreads GCRA starts and has no idle timers or store calls', async () => {
    const store = memoryStore();
    const spy = vi.spyOn(store, 'acquireSync');
    const valve = make({ id: 'x', rate: { limit: 2, interval: 100 }, store });
    const times: number[] = [];
    const tasks = Array.from({ length: 4 }, () =>
      valve.run(() => times.push(Date.now())),
    );
    await vi.runAllTimersAsync();
    await Promise.all(tasks);
    expect(times[0]).toBe(0);
    for (let i = 1; i < times.length; i++)
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(50);
    expect(vi.getTimerCount()).toBe(0);
    const count = spy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(spy).toHaveBeenCalledTimes(count);
  });
  it.each(['sync', 'async'])(
    'wakes at GCRA eligibility without jitter with a %s store',
    async (kind) => {
      const random = vi.spyOn(Math, 'random').mockReturnValue(0.99);
      try {
        const store = memoryStore();
        if (kind === 'async') delete store.acquireSync;
        const valve = make({
          id: 'paced',
          rate: { limit: 100, interval: 1000 },
          store,
        });
        const times: number[] = [];
        const tasks = Array.from({ length: 4 }, () =>
          valve.run(() => times.push(Date.now())),
        );
        await vi.runAllTimersAsync();
        await Promise.all(tasks);
        expect(times).toEqual([0, 10, 20, 30]);
        expect(random).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        random.mockRestore();
      }
    },
  );
  it('rechecks shared admission when several valves wake at the same deadline', async () => {
    const store = memoryStore();
    const times: number[] = [];
    const workers = Array.from({ length: 8 }, () =>
      make({ id: 'shared', rate: { limit: 100, interval: 1000 }, store }),
    );
    const tasks = Array.from({ length: 32 }, (_, i) =>
      workers[i % workers.length]!.run(() => times.push(Date.now())),
    );
    await vi.runAllTimersAsync();
    await Promise.all(tasks);
    expect(times).toEqual(Array.from({ length: 32 }, (_, i) => i * 10));
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not catch up admissions after a delayed wakeup', async () => {
    const valve = make({ id: 'late', rate: { limit: 100, interval: 1000 } });
    const times: number[] = [];
    const tasks = Array.from({ length: 3 }, () =>
      valve.run(() => times.push(Date.now())),
    );
    await tick();
    vi.setSystemTime(100);
    await vi.runAllTimersAsync();
    await Promise.all(tasks);
    expect(times).toEqual([0, 110, 120]);
  });
  it('includes asynchronous store response time in rate eligibility waits', async () => {
    const store = memoryStore();
    const acquire = store.acquireSync!;
    delete store.acquireSync;
    store.acquire = async (request) => {
      const result = acquire(request);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return result;
    };
    const valve = make({
      id: 'response',
      rate: { limit: 100, interval: 1000 },
      store,
    });
    const times: number[] = [];
    const jobs = Array.from({ length: 3 }, () =>
      valve.run(() => times.push(Date.now())),
    );
    await vi.runAllTimersAsync();
    await Promise.all(jobs);
    expect(times).toEqual([5, 15, 25]);
  });
  it.each([-1000, 1000])(
    'measures acquisition time independently of a %ims local clock change',
    async (jump) => {
      vi.setSystemTime(10000);
      // Model an authoritative store clock unaffected by the client's wall clock.
      const store = memoryStore({ clock: () => performance.now() });
      const acquire = store.acquireSync!;
      delete store.acquireSync;
      store.acquire = async (request) => {
        const result = acquire(request);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return result;
      };
      const valve = make({
        id: 'clock',
        rate: { limit: 100, interval: 1000 },
        store,
      });
      const times: number[] = [];
      const jobs = Array.from({ length: 3 }, () =>
        valve.run(() => times.push(performance.now())),
      );
      await vi.advanceTimersByTimeAsync(2);
      vi.setSystemTime(Date.now() + jump);
      await vi.runAllTimersAsync();
      await Promise.all(jobs);
      expect(times).toEqual([5, 15, 25]);
    },
  );
  it('rechecks admission after variable outbound latency without catching up', async () => {
    const store = memoryStore();
    const acquire = store.acquireSync!;
    delete store.acquireSync;
    const admissions: number[] = [];
    let calls = 0;
    store.acquire = async (request) => {
      await new Promise((resolve) =>
        setTimeout(resolve, calls++ === 0 ? 8 : 1),
      );
      const result = acquire(request);
      if (result.granted) admissions.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 1));
      return result;
    };
    const valve = make({
      id: 'outbound',
      rate: { limit: 100, interval: 1000 },
      store,
    });
    const jobs = Array.from({ length: 3 }, () => valve.run(() => undefined));
    await vi.runAllTimersAsync();
    await Promise.all(jobs);
    expect(admissions).toHaveLength(3);
    expect(calls).toBeGreaterThan(3); // An early estimate was denied by the store.
    for (let i = 1; i < admissions.length; i++)
      expect(admissions[i]! - admissions[i - 1]!).toBeGreaterThanOrEqual(10);
  });
  it('does not catch up after a store response arrives past eligibility', async () => {
    const store = memoryStore();
    const acquire = store.acquireSync!;
    delete store.acquireSync;
    const admissions: number[] = [];
    store.acquire = async (request) => {
      const result = acquire(request);
      if (result.granted) admissions.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 25));
      return result;
    };
    const valve = make({
      id: 'late-response',
      rate: { limit: 100, interval: 1000 },
      store,
    });
    const jobs = Array.from({ length: 3 }, () => valve.run(() => undefined));
    await vi.runAllTimersAsync();
    await Promise.all(jobs);
    expect(admissions).toEqual([0, 26, 52]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('allows a fixed-window burst with weighted jobs', async () => {
    const valve = make({
      id: 'x',
      rate: { limit: 4, interval: 100, algorithm: 'fixed-window' },
    });
    const nextWindow = vi.fn(() => Date.now());
    const tasks = [
      valve.run(() => 1, { cost: 3 }),
      valve.run(() => 2),
      valve.run(nextWindow),
    ];
    await tick();
    expect(await tasks[0]).toBe(1);
    expect(await tasks[1]).toBe(2);
    expect(nextWindow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(nextWindow).toHaveBeenCalledOnce();
    expect(await tasks[2]).toBe(100);
  });
  it('passes job errors through without wrapping', async () => {
    const valve = make({ id: 'x', concurrency: 1 });
    const error = new Error('job');
    const a = valve.run(() => {
      throw error;
    });
    const b = valve.run(() => Promise.reject(error));
    const checks = [
      expect(a).rejects.toBe(error),
      expect(b).rejects.toBe(error),
    ];
    await tick();
    await Promise.all(checks);
    expect(valve.stats().totals.failed).toBe(2);
  });
  it('wraps functions preserving arguments and awaited returns', async () => {
    const valve = make({ id: 'x', concurrency: 1 });
    const wrapped = valve.wrap((a: number, b: number) => a + b);
    const result = wrapped(2, 3);
    await tick();
    expect(await result).toBe(5);
  });
  it.each([
    { cost: 0 },
    { cost: 1.5 },
    { priority: 1.2 },
    { priority: Infinity },
    { maxWait: -1 },
  ])('rejects invalid job options asynchronously', async (options) => {
    const valve = make({ id: 'x', concurrency: 1 });
    await expect(valve.run(() => 1, options)).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    });
  });
  it('rejects invalid job functions and impossible costs', async () => {
    const valve = make({
      id: 'hubspot',
      rate: { limit: 190, interval: '10s' },
    });
    await expect(
      valve.run(null as unknown as () => void),
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    await expect(valve.run(() => 1, { cost: 5 })).rejects.toThrow(
      'valve("hubspot"): job cost 5 is greater than burst 1 of rule gcra:10000, so it can never start. Set burst to at least 5 on that rule.',
    );
    const fixed = make({
      id: 'x',
      rate: { limit: 2, interval: 100, algorithm: 'fixed-window' },
    });
    await expect(fixed.run(() => 1, { cost: 3 })).rejects.toMatchObject({
      code: 'COST_EXCEEDS_LIMIT',
    });
  });
});

describe('cancellation and lifecycle', () => {
  it('bounds the waiting queue and emits rejects', async () => {
    const valve = make({ id: 'hubspot', concurrency: 1, maxQueue: 1 });
    const listener = vi.fn();
    valve.on('reject', listener);
    const task = valve.run(() => 1);
    await expect(valve.run(() => 2)).rejects.toThrow(
      'valve("hubspot"): queue is full (maxQueue 1). Raise maxQueue, or shed load before calling run.',
    );
    await tick();
    expect(await task).toBe(1);
    expect(listener).toHaveBeenCalledWith({ code: 'QUEUE_FULL' });
  });
  it('honors default maxWait and per-job overrides without timing out running jobs', async () => {
    const valve = make({
      id: 'hubspot',
      rate: { limit: 1, interval: '10s' },
      maxWait: '5s',
    });
    const first = valve.run(() => 1);
    const timeout = valve.run(() => 2);
    const override = valve.run(() => 3, { maxWait: 100 });
    const rejected = [
      expect(timeout).rejects.toThrow(
        'valve("hubspot"): job waited longer than maxWait 5000ms.',
      ),
      expect(override).rejects.toMatchObject({ code: 'MAX_WAIT_EXCEEDED' }),
    ];
    await vi.advanceTimersByTimeAsync(6000);
    await Promise.all(rejected);
    expect(await first).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('runs a zero maxWait job only when capacity is free immediately', async () => {
    const valve = make({ id: 'x', concurrency: 1 });
    expect(await valve.run(() => 1, { maxWait: 0 })).toBe(1);
    let release!: () => void;
    const busy = valve.run(() => new Promise<void>((r) => (release = r)));
    const queued = valve.run(() => 2, { maxWait: 0 });
    const check = expect(queued).rejects.toMatchObject({
      code: 'MAX_WAIT_EXCEEDED',
    });
    await tick();
    await check;
    release();
    await busy;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects a zero maxWait job the store denies instead of requeueing it', async () => {
    const valve = make({ id: 'x', rate: { limit: 1, interval: 1000 } });
    expect(await valve.run(() => 1, { maxWait: 0 })).toBe(1);
    const denied = valve.run(() => 2, { maxWait: 0 });
    const check = expect(denied).rejects.toMatchObject({
      code: 'MAX_WAIT_EXCEEDED',
    });
    await tick();
    await check;
    expect(valve.stats().queued).toBe(0);
  });
  it('lets a slow store answer a zero maxWait admission', async () => {
    const valve = make({
      id: 'x',
      concurrency: 1,
      store: failing(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ granted: 1, retryAfterMs: 0, pausedMs: 0 }),
              20,
            ),
          ),
      ),
    });
    const job = valve.run(() => 1, { maxWait: 0 });
    await vi.advanceTimersByTimeAsync(20);
    expect(await job).toBe(1);
  });
  it('rejects a zero maxWait job when a pending store reports a pause', async () => {
    let resolveAcquire!: (result: AcquireResult) => void;
    const acquire = vi.fn(
      () =>
        new Promise<AcquireResult>((resolve) => {
          resolveAcquire = resolve;
        }),
    );
    const valve = make({ id: 'x', concurrency: 1, store: failing(acquire) });
    const fn = vi.fn(() => 1);
    const check = expect(valve.run(fn, { maxWait: 0 })).rejects.toMatchObject({
      code: 'MAX_WAIT_EXCEEDED',
    });
    // Expiration must leave the pending admission for the store reply to settle.
    await vi.advanceTimersByTimeAsync(0);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(valve.stats().queued).toBe(1);
    resolveAcquire({ granted: 0, retryAfterMs: 100, pausedMs: 100 });
    await check;
    expect(valve.stats().queued).toBe(0);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(fn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects a zero maxWait job during a store outage', async () => {
    const valve = make({
      id: 'x',
      concurrency: 1,
      store: failing(() => Promise.reject(new Error('down'))),
    });
    const job = valve.run(() => 1, { maxWait: 0 });
    const check = expect(job).rejects.toMatchObject({
      code: 'MAX_WAIT_EXCEEDED',
    });
    await tick();
    await check;
  });
  it('aborts before and during queue wait with the original reason', async () => {
    const valve = make({ id: 'x', rate: { limit: 1, interval: 100 } });
    const c = new AbortController();
    c.abort('reason');
    await expect(
      valve.run(() => 1, { signal: c.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED', cause: 'reason' });
    const d = new AbortController();
    const first = valve.run(() => 1);
    const second = valve.run(() => 2, { signal: d.signal });
    const check = expect(second).rejects.toMatchObject({
      code: 'ABORTED',
      cause: 'later',
    });
    await tick();
    d.abort('later');
    await tick();
    await check;
    expect(await first).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('passes a running signal to the job without interrupting it', async () => {
    const valve = make({ id: 'x', concurrency: 1 });
    const controller = new AbortController();
    let resolve!: () => void;
    const promise = valve.run(
      (ctx) => {
        expect(ctx.signal).toBe(controller.signal);
        return new Promise<void>((r) => {
          resolve = r;
        });
      },
      { signal: controller.signal, maxWait: 1 },
    );
    await tick();
    controller.abort();
    await vi.advanceTimersByTimeAsync(100);
    expect(valve.stats().running).toBe(1);
    resolve();
    await promise;
  });
  it('spends an in-flight grant when its job was cancelled', async () => {
    let resolve!: (value: AcquireResult) => void;
    const valve = make({
      id: 'x',
      rate: { limit: 1, interval: 100 },
      store: failing(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      ),
    });
    const controller = new AbortController();
    const fn = vi.fn();
    const job = valve.run(fn, { signal: controller.signal });
    const check = expect(job).rejects.toMatchObject({ code: 'ABORTED' });
    await tick();
    controller.abort();
    resolve({ granted: 1, retryAfterMs: 0, pausedMs: 0 });
    await tick();
    await check;
    expect(fn).not.toHaveBeenCalled();
    expect(valve.stats().totals.started).toBe(0);
  });
  it('close rejects waiting jobs, drains running jobs, and is idempotent', async () => {
    const valve = make({ id: 'hubspot', concurrency: 1 });
    let finish!: () => void;
    const running = valve.run(
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    await tick();
    const waiting = valve.run(() => 2);
    const check = expect(waiting).rejects.toMatchObject({ code: 'CLOSED' });
    const closed = valve.close();
    expect(valve.close()).toBe(closed);
    await check;
    await expect(valve.run(() => 3)).rejects.toThrow(
      'valve("hubspot"): valve is closed.',
    );
    expect(valve.stats().running).toBe(1);
    finish();
    await running;
    await closed;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('drains queued jobs, disposes, and resolves idle on a later microtask', async () => {
    const valve = make({ id: 'x', concurrency: 1 });
    let resolved = false;
    const empty = valve.idle().then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    await empty;
    const jobs = [valve.run(() => 1), valve.run(() => 2)];
    const idle = valve.idle();
    const close = valve.close({ drain: true });
    await tick();
    await Promise.all(jobs);
    await idle;
    await close;
    await valve[Symbol.asyncDispose]();
  });
  it.each([false, true])(
    'releases grants from an in-flight admission before close resolves (scoped=%s)',
    async (scoped) => {
      const base = memoryStore();
      const released: string[] = [];
      const store: Store = {
        kind: base.kind,
        pause: base.pause,
        resume: base.resume,
        renew: base.renew!,
        subscribe: base.subscribe!,
        close: base.close,
        acquire: (request) =>
          new Promise((resolve) =>
            setTimeout(() => resolve(base.acquireSync!(request)), 50),
          ),
        acquireScoped: (request) =>
          new Promise((resolve) =>
            setTimeout(() => resolve(base.acquireScopedSync!(request)), 50),
          ),
        release: (id, tokens) => {
          released.push(...tokens);
          return base.release!(id, tokens);
        },
      };
      const valve = make({
        id: 'closing',
        concurrency: { limit: 1, scope: 'global' },
        ...(scoped
          ? {
              rate: { name: 'r', scope: 'tenant', limit: 5, interval: 1000 },
            }
          : {}),
        store,
      });
      const job = valve.run(() => 1, scoped ? { scopes: { tenant: 't' } } : {});
      const check = expect(job).rejects.toMatchObject({ code: 'CLOSED' });
      await tick();
      let closed = false;
      const closing = valve.close().then(() => {
        closed = true;
      });
      await check;
      await tick();
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(50);
      await closing;
      expect(released).toHaveLength(1);
    },
  );
  it('never closes a user-owned store', async () => {
    const store = memoryStore();
    const spy = vi.spyOn(store, 'close');
    const valve = make({ id: 'x', concurrency: 1, store });
    await valve.close();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('pauses and feedback', () => {
  it.each([200, 429, 503])(
    'blocks shared admissions through the longest exhausted reset on status %s',
    async (status) => {
      const store = memoryStore();
      const valve = make({ id: 'mixed', concurrency: 1, store });
      const peer = make({ id: 'mixed', concurrency: 1, store });
      valve.observe({
        status,
        headers: {
          RateLimit: 'r=10;t=60',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '120',
        },
      });
      expect(valve.stats().pausedUntil).toBe(120000);
      const fn = vi.fn(() => Date.now());
      const job = peer.run(fn);
      await vi.advanceTimersByTimeAsync(119999);
      expect(fn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(26);
      expect(await job).toBeGreaterThanOrEqual(120000);
    },
  );
  it.each([429, 503])(
    'preserves Retry-After precedence on status %s',
    (status) => {
      const valve = make({ id: 'explicit', concurrency: 1 });
      valve.observe({
        status,
        headers: {
          RateLimit: 'r=0;t=60',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '120',
          'Retry-After': '1',
        },
      });
      expect(valve.stats().pausedUntil).toBe(1000);
    },
  );
  it('uses 429 backoff when the exhausted quota has no usable reset', () => {
    const valve = make({ id: 'missing-reset', concurrency: 1 });
    valve.observe({
      status: 429,
      headers: {
        RateLimit: 'r=10;t=60',
        'x-ratelimit-remaining': '0',
      },
    });
    expect(valve.stats().pausedUntil).toBe(1000);
  });
  it('caps mixed quota feedback and does not pause on an exhausted quota without its own reset', () => {
    const valve = make({ id: 'mixed', concurrency: 1, maxPause: 1500 });
    const warning = vi.fn();
    valve.on('warning', warning);
    valve.observe({
      status: 200,
      headers: { RateLimit: 'r=10;t=60', 'x-ratelimit-remaining': '0' },
    });
    expect(valve.stats().pausedUntil).toBeNull();
    valve.observe({
      status: 200,
      headers: {
        RateLimit: 'r=10;t=60',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '120',
      },
    });
    expect(valve.stats().pausedUntil).toBe(1500);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('shares observed feedback by id without pausing an independent quota', async () => {
    const store = memoryStore();
    const search = make({ id: 'partner:search', concurrency: 1, store });
    const peer = make({ id: 'partner:search', concurrency: 1, store });
    const exportData = make({ id: 'partner:export', concurrency: 1, store });
    search.observe({ status: 429, headers: { 'Retry-After': '1' } });

    const sharedFn = vi.fn(() => 'search complete');
    const sharedJob = peer.run(sharedFn);
    const independentJob = exportData.run(() => 'export complete');
    await tick();

    expect(await independentJob).toBe('export complete');
    expect(exportData.stats().pausedUntil).toBeNull();
    expect(sharedFn).not.toHaveBeenCalled();
    expect(peer.stats().queued).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(sharedFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(26);
    expect(await sharedJob).toBe('search complete');
    expect(sharedFn).toHaveBeenCalledTimes(1);
  });
  it('extends manual pauses, emits resume on expiry, and leaves no idle timer', async () => {
    const valve = make({ id: 'x', concurrency: 1 });
    const pause = vi.fn();
    const resume = vi.fn();
    valve.on('pause', pause);
    valve.on('resume', resume);
    await valve.pause(100);
    await valve.pause(20);
    expect(vi.getTimerCount()).toBe(0);
    const job = valve.run(() => Date.now());
    await vi.advanceTimersByTimeAsync(120);
    expect(await job).toBeGreaterThanOrEqual(100);
    expect(pause).toHaveBeenCalledTimes(2);
    expect(resume).toHaveBeenCalledWith({ reason: 'expired' });
  });
  it('sees a shared pause even on a concurrency-only valve and resumes manually', async () => {
    const store = memoryStore();
    const a = make({ id: 'x', concurrency: 1, store });
    const b = make({ id: 'x', concurrency: 1, store });
    const listener = vi.fn();
    b.on('pause', listener);
    await a.pause(100);
    const job = b.run(() => 1);
    await tick();
    expect(listener).toHaveBeenCalledWith({ reason: 'store', durationMs: 100 });
    expect(b.stats().queued).toBe(1);
    await b.resume();
    await tick();
    expect(await job).toBe(1);
  });
  it('caps feedback pauses, handles throwing feedback, doubles and resets backoff', async () => {
    const valve = make({ id: 'x', concurrency: 1, maxPause: 1500 });
    const warning = vi.fn();
    valve.on('warning', warning);
    valve.observe({ status: 429, headers: { 'retry-after': '20' } });
    expect(valve.stats().pausedUntil).toBe(1500);
    expect(warning).toHaveBeenCalled();
    await valve.resume();
    valve.observe({ status: 429, headers: {} });
    expect(valve.stats().pausedUntil).toBe(1500);
    await valve.resume();
    valve.observe({ status: 200, headers: {} });
    valve.observe({ status: 429, headers: {} });
    expect(valve.stats().pausedUntil).toBe(1000);
    const throwing = make({
      id: 't',
      concurrency: 1,
      feedback: () => {
        throw new Error('bad');
      },
    });
    const warn = vi.fn();
    throwing.on('warning', warn);
    throwing.observe({ status: 429, headers: {} });
    expect(warn).toHaveBeenCalled();
    expect(throwing.stats().pausedUntil).toBe(1000);
  });
  it('handles remaining/reset and feedback false while preserving 429 backoff', async () => {
    const valve = make({ id: 'x', concurrency: 1 });
    valve.observe({
      status: 200,
      headers: { 'ratelimit-remaining': '0', 'ratelimit-reset': '2' },
    });
    expect(valve.stats().pausedUntil).toBe(2000);
    const off = make({ id: 'off', concurrency: 1, feedback: false });
    off.observe({ status: 200, headers: { 'retry-after': '20' } });
    expect(off.stats().pausedUntil).toBeNull();
    off.observe({ status: 429, headers: { 'retry-after': '20' } });
    expect(off.stats().pausedUntil).toBe(1000);
    await valve.resume();
    expect(valve.stats().pausedUntil).toBeNull();
  });
  it('observes client results and guards observer errors', async () => {
    const valve = make({ id: 'x', concurrency: 1 });
    const response = { status: 429, headers: { 'retry-after': '1' } };
    const promise = valve.run(() => response, { observe: (r) => r });
    await tick();
    expect(await promise).toBe(response);
    expect(valve.stats().pausedUntil).toBe(1000);
    await valve.resume();
    const warn = vi.fn();
    valve.on('warning', warn);
    const second = valve.run(() => 1, {
      observe: () => {
        throw new Error('map');
      },
    });
    await tick();
    expect(await second).toBe(1);
    expect(warn).toHaveBeenCalled();
    const none = valve.run(() => 2, { observe: () => undefined });
    await tick();
    expect(await none).toBe(2);
  });
  it('reports a failed background pause write without an unhandled rejection', async () => {
    const store = failing(() =>
      Promise.resolve({ granted: 1, retryAfterMs: 0, pausedMs: 0 }),
    );
    store.pause = () => Promise.reject(new Error('offline'));
    const valve = make({ id: 'x', concurrency: 1, store });
    const errors = vi.fn();
    valve.on('store-error', errors);
    valve.observe({ status: 429, headers: {} });
    await tick();
    expect(errors).toHaveBeenCalledTimes(1);
  });
});

describe('optional subscriptions', () => {
  it.each(['sync', 'async'] as const)(
    'admits through the %s store while subscription startup remains pending',
    async (mode) => {
      const backing = memoryStore();
      const acquire = vi.fn(backing.acquire);
      const acquireSync = vi.fn(backing.acquireSync!);
      const subscribe = vi.fn(() => new Promise<() => void>(() => {}));
      const store: Store = { ...backing, acquire, acquireSync, subscribe };
      if (mode === 'async') delete store.acquireSync;
      const valve = make({
        id: 'pending',
        rate: { limit: 10, interval: '1s' },
        store,
      });
      const job = valve.run(() => 42);
      await tick();
      expect(valve.stats().totals.started).toBe(1);
      expect(await job).toBe(42);
      expect(mode === 'sync' ? acquireSync : acquire).toHaveBeenCalledTimes(1);
      expect(subscribe).toHaveBeenCalledTimes(1);
      await valve.close({ drain: true });
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it('keeps shared rate limits and store pauses authoritative without notifications', async () => {
    const backing = memoryStore();
    await backing.pause('shared', 100);
    const store = {
      ...backing,
      subscribe: () => new Promise<() => void>(() => {}),
    };
    const options = { id: 'shared', rate: { limit: 1, interval: 100 }, store };
    const first = make(options);
    const second = make(options);
    const jobs = [first.run(() => Date.now()), second.run(() => Date.now())];
    await vi.advanceTimersByTimeAsync(99);
    expect(first.stats().totals.started + second.stats().totals.started).toBe(
      0,
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(first.stats().totals.started + second.stats().totals.started).toBe(
      1,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect((await Promise.all(jobs)).sort((a, b) => a - b)).toEqual([100, 200]);
  });
  it('keeps queued jobs abortable, bounded by maxWait, and closable during startup', async () => {
    const acquire = vi
      .fn<Store['acquire']>()
      .mockResolvedValue({ granted: 0, retryAfterMs: 1000, pausedMs: 0 });
    const valve = make({
      id: 'pending',
      concurrency: 1,
      store: {
        ...failing(acquire),
        subscribe: () => new Promise<() => void>(() => {}),
      },
    });
    const controller = new AbortController();
    const aborted = expect(
      valve.run(() => 1, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    const expired = expect(
      valve.run(() => 2, { maxWait: 100 }),
    ).rejects.toMatchObject({ code: 'MAX_WAIT_EXCEEDED' });
    const closed = expect(valve.run(() => 3)).rejects.toMatchObject({
      code: 'CLOSED',
    });
    await tick();
    expect(acquire).toHaveBeenCalledTimes(1);
    controller.abort();
    await aborted;
    await vi.advanceTimersByTimeAsync(100);
    await expired;
    await valve.close();
    await closed;
    expect(valve.stats().totals.started).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['wait', 'open', 'throw'] as const)(
    'reports a failed subscription without applying the %s admission error policy',
    async (onStoreError) => {
      let reject!: (error: Error) => void;
      const backing = memoryStore();
      const valve = make({
        id: 'failed',
        concurrency: 1,
        onStoreError,
        store: {
          ...backing,
          subscribe: () =>
            new Promise<() => void>((_resolve, r) => {
              reject = r;
            }),
        },
      });
      const errors = vi.fn();
      valve.on('store-error', errors);
      reject(new Error('subscriber offline'));
      const job = valve.run(() => 42);
      await tick();
      expect(await job).toBe(42);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(valve.stats().totals.storeErrors).toBe(1);
    },
  );
  it('restores fast wake-ups after late readiness without subscribing again', async () => {
    const backing = memoryStore();
    let resolve!: (off: () => void) => void;
    let notify!: Parameters<NonNullable<Store['subscribe']>>[1];
    const off = vi.fn();
    const subscribe = vi.fn((_id: string, listener: typeof notify) => {
      notify = listener;
      return new Promise<() => void>((r) => {
        resolve = r;
      });
    });
    const valve = make({
      id: 'recover',
      concurrency: 1,
      store: { ...backing, subscribe },
    });
    await backing.pause('recover', 1000);
    const job = valve.run(() => Date.now());
    await tick();
    expect(valve.stats().queued).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    resolve(off);
    await tick();
    await backing.resume('recover');
    notify({ type: 'resume' });
    await tick();
    expect(await job).toBe(100);
    expect(subscribe).toHaveBeenCalledTimes(1);
    await valve.close();
    expect(off).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('unsubscribes once when startup completes after close', async () => {
    let resolve!: (off: () => void) => void;
    const off = vi.fn();
    const backing = memoryStore();
    const valve = make({
      id: 'closed',
      concurrency: 1,
      store: {
        ...backing,
        subscribe: () =>
          new Promise<() => void>((r) => {
            resolve = r;
          }),
      },
    });
    await valve.close();
    resolve(off);
    await tick();
    await valve.close();
    expect(off).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('store error policies', () => {
  it('retains jitter for outage retries', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const acquire = vi
        .fn<Store['acquire']>()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue({ granted: 1, retryAfterMs: 0, pausedMs: 0 });
      const valve = make({
        id: 'outage',
        concurrency: 1,
        store: failing(acquire),
      });
      const job = valve.run(() => Date.now());
      await vi.advanceTimersByTimeAsync(104);
      expect(acquire).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await job).toBe(105);
      expect(random).toHaveBeenCalledTimes(1);
    } finally {
      random.mockRestore();
    }
  });
  it('retains jitter for global-slot polling', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const acquire = vi
        .fn<Store['acquire']>()
        .mockResolvedValueOnce({ granted: 0, retryAfterMs: 1000, pausedMs: 0 })
        .mockResolvedValue({
          granted: 1,
          retryAfterMs: 0,
          pausedMs: 0,
          leases: ['slot'],
        });
      const store = {
        ...failing(acquire),
        release: async () => {},
        renew: async () => true,
      };
      const valve = make({
        id: 'slots',
        concurrency: { limit: 1, scope: 'global' },
        store,
      });
      const job = valve.run(() => Date.now());
      await vi.advanceTimersByTimeAsync(62);
      expect(acquire).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await job).toBe(63);
      expect(random).toHaveBeenCalledTimes(1);
      await valve.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      random.mockRestore();
    }
  });
  it.each(['open', 'throw'] as const)(
    'handles %s without breaking concurrency',
    async (policy) => {
      const error = new Error('offline');
      const valve = make({
        id: 'x',
        concurrency: 1,
        rate: { limit: 1, interval: 100 },
        store: failing(() => Promise.reject(error)),
        onStoreError: policy,
      });
      const job = valve.run(() => 42);
      const check =
        policy === 'throw'
          ? expect(job).rejects.toMatchObject({
              code: 'STORE_UNAVAILABLE',
              cause: error,
            })
          : expect(job).resolves.toBe(42);
      await tick();
      await check;
      expect(valve.stats().totals.storeErrors).toBe(1);
    },
  );
  it('waits with backoff, recovers, honors maxWait, and limits error events', async () => {
    let down = true;
    const store = memoryStore();
    const acquire = vi.fn((request) =>
      down ? Promise.reject(new Error('down')) : store.acquire(request),
    );
    const valve = make({ id: 'x', concurrency: 1, store: failing(acquire) });
    const error = vi.fn();
    valve.on('store-error', error);
    const job = valve.run(() => 42);
    await vi.advanceTimersByTimeAsync(500);
    expect(valve.stats().queued).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
    down = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await job).toBe(42);
  });
  it('handles sync store throws and sync acquire methods that throw', async () => {
    const store = failing(() => {
      throw new Error('sync');
    });
    const valve = make({
      id: 'x',
      concurrency: 1,
      store,
      onStoreError: 'open',
    });
    const job = valve.run(() => 1);
    await tick();
    expect(await job).toBe(1);
    const sync = {
      ...store,
      acquireSync: () => {
        throw new Error('sync fast');
      },
    };
    const other = make({
      id: 'y',
      concurrency: 1,
      store: sync,
      onStoreError: 'throw',
    });
    const denied = other.run(() => 1);
    const check = expect(denied).rejects.toMatchObject({
      code: 'STORE_UNAVAILABLE',
    });
    await tick();
    await check;
  });
  it('rejects on maxWait while store stays unavailable', async () => {
    const valve = make({
      id: 'x',
      concurrency: 1,
      store: failing(() => Promise.reject(new Error('down'))),
      maxWait: 50,
    });
    const job = valve.run(() => 1);
    const check = expect(job).rejects.toMatchObject({
      code: 'MAX_WAIT_EXCEEDED',
    });
    await vi.advanceTimersByTimeAsync(100);
    await check;
    expect(vi.getTimerCount()).toBe(0);
  });
});

it('close does not wait for a cancelled custom-store acquire to settle', async () => {
  let resolve!: (value: AcquireResult) => void;
  const valve = make({
    id: 'late',
    rate: { limit: 1, interval: 100 },
    store: failing(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    ),
  });
  const job = valve.run(() => 1);
  const rejected = expect(job).rejects.toMatchObject({ code: 'CLOSED' });
  await tick();
  await valve.close();
  await rejected;
  await valve.idle();
  resolve({ granted: 1, retryAfterMs: 0, pausedMs: 0 });
  await tick();
  expect(valve.stats().totals.started).toBe(0);
});
