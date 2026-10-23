// Explicit non-atomic composition: order, per-stage options, spent budgets, and held slots.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createValve,
  isValveError,
  memoryStore,
  runSequential,
} from '../src/index.js';
import type { Store, Valve } from '../src/index.js';

const minute = { limit: 1, interval: '1m', algorithm: 'fixed-window' } as const;
const opened: Valve[] = [];
const valve = (options: Parameters<typeof createValve>[0]) => {
  const created = createValve(options);
  opened.push(created);
  return created;
};
const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
};
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const spent = (target: Valve) =>
  target
    .run(() => 'admitted', { maxWait: 0 })
    .then(
      () => false,
      (error: unknown) => isValveError(error, 'MAX_WAIT_EXCEEDED'),
    );
afterEach(async () => {
  await Promise.all(opened.splice(0).map((v) => v.close()));
});

describe('runSequential', () => {
  it('admits stages outermost first, then runs fn once with the shared signal', async () => {
    const order: string[] = [];
    const stores = ['a', 'b', 'c'].map((name) => {
      const store = memoryStore();
      const acquire = store.acquireSync!.bind(store);
      store.acquireSync = (request) => {
        order.push(name);
        return acquire(request);
      };
      return store;
    });
    const stages = stores.map((store, i) => ({
      valve: valve({ id: `order-${i}`, rate: minute, store }),
    }));
    const controller = new AbortController();
    const fn = vi.fn(({ signal }: { signal: AbortSignal | undefined }) => {
      order.push('fn');
      return signal;
    });
    await expect(
      runSequential(stages, fn, { signal: controller.signal }),
    ).resolves.toBe(controller.signal);
    expect(order).toEqual(['a', 'b', 'c', 'fn']);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('preserves sync and async values and thrown errors unchanged', async () => {
    const a = valve({ id: 'values-a', concurrency: 1 });
    const b = valve({ id: 'values-b', concurrency: 1 });
    const stages = [{ valve: a }, { valve: b }];
    await expect(runSequential(stages, () => 42)).resolves.toBe(42);
    await expect(runSequential(stages, async () => 'x')).resolves.toBe('x');
    const thrown = new Error('job failed');
    await expect(
      runSequential(stages, () => {
        throw thrown;
      }),
    ).rejects.toBe(thrown);
    await expect(
      runSequential(stages, () => Promise.reject(thrown)),
    ).rejects.toBe(thrown);
    expect(a.stats().totals).toMatchObject({ started: 4, failed: 2 });
    expect(b.stats().totals).toMatchObject({ started: 4, failed: 2 });
  });

  it('runs a single stage like run', async () => {
    const a = valve({ id: 'single', rate: minute });
    await expect(runSequential([{ valve: a }], () => 'one')).resolves.toBe(
      'one',
    );
    expect(await spent(a)).toBe(true);
  });

  it.each([
    ['no stages', [], () => 1],
    ['a non-array', { valve: 1 }, () => 1],
    ['a stage without a valve', [{}], () => 1],
    ['a non-function job', 'stages', 'job'],
    ['a repeated valve', 'repeat', () => 1],
    ['a repeated id', 'same-id', () => 1],
  ] as [string, unknown, unknown][])(
    'rejects %s with INVALID_OPTIONS before any stage admits',
    async (_, stages, fn) => {
      const a = valve({ id: 'invalid-a', rate: minute });
      const twin = valve({ id: 'invalid-a', rate: minute });
      const run = vi.spyOn(a, 'run');
      const resolved =
        stages === 'stages'
          ? [{ valve: a }]
          : stages === 'repeat'
            ? [{ valve: a }, { valve: a }]
            : stages === 'same-id'
              ? [{ valve: a }, { valve: twin }]
              : stages;
      let pending: Promise<unknown> | undefined;
      expect(() => {
        pending = runSequential(resolved as never, fn as never);
      }).not.toThrow();
      await expect(pending).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
      expect(run).not.toHaveBeenCalled();
      expect(await spent(a)).toBe(false);
    },
  );

  it('passes each stage only its own cost and scopes', async () => {
    const requests: Record<string, unknown[]> = { a: [], b: [] };
    const store = (name: 'a' | 'b') => {
      const s = memoryStore();
      const acquire = s.acquireSync!.bind(s);
      const scoped = s.acquireScopedSync!.bind(s);
      s.acquireSync = (request) => {
        requests[name]!.push(request.costs);
        return acquire(request);
      };
      s.acquireScopedSync = (request) => {
        requests[name]!.push(request.jobs);
        return scoped(request);
      };
      return s;
    };
    const a = valve({
      id: 'options-a',
      rate: { limit: 10, interval: '1m', burst: 10 },
      store: store('a'),
    });
    const b = valve({
      id: 'options-b',
      rate: [
        { name: 'all', limit: 10, interval: '1m', burst: 10 },
        {
          name: 'tenant',
          scope: 'tenant',
          limit: 10,
          interval: '1m',
          burst: 10,
        },
      ],
      store: store('b'),
    });
    await runSequential(
      [
        { valve: a, options: { cost: 3 } },
        { valve: b, options: { cost: 2, scopes: { tenant: 't1' } } },
      ],
      () => 'ok',
    );
    expect(requests.a).toEqual([[3]]);
    expect(requests.b).toEqual([[{ cost: 2, scopes: { tenant: 't1' } }]]);
  });

  it('orders a waiting stage by its own priority, not an earlier stage priority', async () => {
    const a = valve({ id: 'priority-a', concurrency: 5 });
    const b = valve({ id: 'priority-b', concurrency: 1 });
    const gate = deferred();
    const blocker = b.run(() => gate.promise);
    const order: string[] = [];
    const low = runSequential(
      [{ valve: a, options: { priority: 100 } }, { valve: b }],
      () => order.push('low'),
    );
    const high = runSequential(
      [{ valve: a }, { valve: b, options: { priority: 5 } }],
      () => order.push('high'),
    );
    await tick();
    expect(b.stats().queued).toBe(2);
    gate.release();
    await Promise.all([blocker, low, high]);
    expect(order).toEqual(['high', 'low']);
  });

  it('leaves an earlier stage spent when a later stage rejects, unlike one scoped valve', async () => {
    const ingress = valve({ id: 'spent-ingress', rate: minute });
    const tenant = valve({ id: 'spent-tenant', rate: minute });
    await tenant.run(() => 'exhaust');
    const fn = vi.fn();
    const error = await runSequential(
      [{ valve: ingress }, { valve: tenant, options: { maxWait: 0 } }],
      fn,
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'MAX_WAIT_EXCEEDED',
      valveId: 'spent-tenant',
    });
    expect(fn).not.toHaveBeenCalled();
    expect(await spent(ingress)).toBe(true);
    expect(ingress.stats().totals).toMatchObject({ started: 1, failed: 1 });

    const atomic = valve({
      id: 'atomic',
      rate: [
        {
          name: 'ingress',
          limit: 2,
          interval: '1m',
          algorithm: 'fixed-window',
        },
        { name: 'tenant', scope: 'tenant', ...minute },
      ],
    });
    await atomic.run(() => 'exhaust t1', { scopes: { tenant: 't1' } });
    await expect(
      atomic.run(fn, { scopes: { tenant: 't1' }, maxWait: 0 }),
    ).rejects.toMatchObject({ code: 'MAX_WAIT_EXCEEDED' });
    // The denied job spent nothing, so the shared rule still admits one more.
    await expect(
      atomic.run(() => 't2', { scopes: { tenant: 't2' }, maxWait: 0 }),
    ).resolves.toBe('t2');
    expect(fn).not.toHaveBeenCalled();
  });

  it('aborts before the first stage without admitting it', async () => {
    const a = valve({ id: 'abort-a', rate: minute });
    const b = valve({ id: 'abort-b', rate: minute });
    const controller = new AbortController();
    controller.abort(new Error('gone'));
    await expect(
      runSequential([{ valve: a }, { valve: b }], vi.fn(), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'ABORTED', valveId: 'abort-a' });
    expect(await spent(a)).toBe(false);
  });

  it('aborts a waiting later stage, keeps the earlier admission spent, and frees its slot', async () => {
    const a = valve({ id: 'abort-wait-a', rate: minute, concurrency: 1 });
    const b = valve({ id: 'abort-wait-b', concurrency: 1 });
    const gate = deferred();
    const blocker = b.run(() => gate.promise);
    const controller = new AbortController();
    const fn = vi.fn();
    const pending = runSequential([{ valve: a }, { valve: b }], fn, {
      signal: controller.signal,
    });
    await tick();
    expect(a.stats()).toMatchObject({ running: 1, queued: 0 });
    expect(b.stats()).toMatchObject({ running: 1, queued: 1 });
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: 'ABORTED',
      valveId: 'abort-wait-b',
    });
    expect(fn).not.toHaveBeenCalled();
    expect(a.stats().running).toBe(0);
    expect(await spent(a)).toBe(true);
    gate.release();
    await blocker;
  });

  it('applies maxWait per stage, not end to end', async () => {
    const a = valve({ id: 'wait-a', concurrency: 1, maxWait: 10 });
    const b = valve({ id: 'wait-b', concurrency: 1 });
    const gate = deferred();
    const blocker = b.run(() => gate.promise);
    // a's 10 ms limit covers only a's queue; b waits without a limit.
    const slow = runSequential([{ valve: a }, { valve: b }], () => 'late');
    await new Promise((resolve) => setTimeout(resolve, 40));
    gate.release();
    await expect(slow).resolves.toBe('late');
    await blocker;

    const blocker2 = b.run(() => new Promise((r) => setTimeout(r, 50)));
    await expect(
      runSequential(
        [{ valve: a }, { valve: b, options: { maxWait: 10 } }],
        () => 'never',
      ),
    ).rejects.toMatchObject({ code: 'MAX_WAIT_EXCEEDED', valveId: 'wait-b' });
    await blocker2;
  });

  it('propagates QUEUE_FULL and CLOSED from a later stage without closing others', async () => {
    const store = memoryStore();
    const a = valve({
      id: 'full-a',
      rate: { limit: 5, interval: '1m', burst: 5 },
      store,
    });
    const b = valve({ id: 'full-b', concurrency: 1, maxQueue: 1 });
    const gate = deferred();
    const blocker = b.run(() => gate.promise);
    await tick();
    const filler = b.run(() => 'filler');
    await tick();
    await expect(
      runSequential([{ valve: a }, { valve: b }], () => 'x'),
    ).rejects.toMatchObject({ code: 'QUEUE_FULL', valveId: 'full-b' });
    gate.release();
    await Promise.all([blocker, filler]);
    await b.close();
    await expect(
      runSequential([{ valve: a }, { valve: b }], () => 'x'),
    ).rejects.toMatchObject({ code: 'CLOSED', valveId: 'full-b' });
    // Two admissions of a were spent and a stays open.
    expect(a.stats().totals.started).toBe(2);
    await expect(a.run(() => 'open')).resolves.toBe('open');
    await store.close();
  });

  it('holds the outer local slot while a later stage waits', async () => {
    const a = valve({ id: 'slot-a', concurrency: 1 });
    const b = valve({ id: 'slot-b', concurrency: 1 });
    const gate = deferred();
    const blocker = b.run(() => gate.promise);
    const order: string[] = [];
    const nested = runSequential([{ valve: a }, { valve: b }], () =>
      order.push('nested'),
    );
    const direct = a.run(() => order.push('direct'));
    await tick();
    expect(a.stats()).toMatchObject({ running: 1, queued: 1 });
    expect(order).toEqual([]);
    gate.release();
    await Promise.all([blocker, nested, direct]);
    expect(order).toEqual(['nested', 'direct']);
  });

  it('holds the outer global lease while a later stage waits', async () => {
    const store = memoryStore();
    const global = { limit: 1, scope: 'global', leaseTtl: '1s' } as const;
    const a = valve({ id: 'lease-a', concurrency: global, store });
    const peer = valve({ id: 'lease-a', concurrency: global, store });
    const b = valve({ id: 'lease-b', concurrency: global, store });
    const gate = deferred();
    const blocker = b.run(() => gate.promise);
    await tick();
    const nested = runSequential([{ valve: a }, { valve: b }], () => 'nested');
    await tick();
    // Another worker sharing a's id cannot start while the lease is held.
    await expect(peer.run(() => 'peer', { maxWait: 30 })).rejects.toMatchObject(
      { code: 'MAX_WAIT_EXCEEDED' },
    );
    gate.release();
    await expect(nested).resolves.toBe('nested');
    await expect(peer.run(() => 'peer')).resolves.toBe('peer');
    await blocker;
    await store.close();
  });

  it('cancels later stages when an outer global lease is lost', async () => {
    vi.useFakeTimers();
    try {
      const backing = memoryStore();
      const store: Store = {
        ...backing,
        renew: () => Promise.reject(new Error('offline')),
      };
      const a = valve({
        id: 'lost-a',
        concurrency: { limit: 1, scope: 'global', leaseTtl: 90 },
        store,
      });
      const b = valve({ id: 'lost-b', concurrency: 1 });
      const gate = deferred();
      const blocker = b.run(() => gate.promise);
      const fn = vi.fn();
      const pending = runSequential([{ valve: a }, { valve: b }], fn);
      const settled = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(b.stats().queued).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(b.stats().queued).toBe(0);
      expect(await settled).toMatchObject({ code: 'LEASE_LOST' });
      gate.release();
      await blocker;
      expect(fn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows why one id is rejected: manual nesting waits on its own slot', async () => {
    const a = valve({ id: 'self', concurrency: 1 });
    const inner = vi.fn();
    await expect(
      a.run(() => a.run(inner, { maxWait: 20 })),
    ).rejects.toMatchObject({ code: 'MAX_WAIT_EXCEEDED', valveId: 'self' });
    expect(inner).not.toHaveBeenCalled();
  });

  it('never feeds responses itself; observe applies once, to its own stage', async () => {
    const a = valve({ id: 'feedback-a', concurrency: 1 });
    const b = valve({ id: 'feedback-b', concurrency: 1 });
    const pauses = { a: vi.fn(), b: vi.fn() };
    a.on('pause', pauses.a);
    b.on('pause', pauses.b);
    const limited = { status: 429, headers: { 'retry-after': '60' } };
    await runSequential([{ valve: a }, { valve: b }], () => limited);
    expect(pauses.a).not.toHaveBeenCalled();
    expect(pauses.b).not.toHaveBeenCalled();
    const observe = vi.fn((r: typeof limited) => r);
    await runSequential(
      [{ valve: a }, { valve: b, options: { observe } }],
      () => limited,
    );
    expect(observe).toHaveBeenCalledExactlyOnceWith(limited);
    expect(pauses.a).not.toHaveBeenCalled();
    // The store may echo the same pause back with reason 'store'.
    const feedback = pauses.b.mock.calls.filter(
      ([event]) => event.reason === 'feedback',
    );
    expect(feedback).toHaveLength(1);
    expect(a.stats().pausedUntil).toBeNull();
    expect(b.stats().totals.retried).toBe(0);
  });

  it('ignores a signal smuggled into stage options by untyped callers', async () => {
    const a = valve({ id: 'smuggle-a', rate: minute });
    const b = valve({ id: 'smuggle-b', rate: minute });
    const options = { signal: AbortSignal.abort() } as never;
    await expect(
      runSequential([{ valve: a }, { valve: b, options }], () => 'ran'),
    ).resolves.toBe('ran');
    const shared = new AbortController();
    const c = valve({ id: 'smuggle-c', concurrency: 1 });
    const d = valve({ id: 'smuggle-d', concurrency: 1 });
    await expect(
      runSequential(
        [{ valve: c }, { valve: d, options }],
        ({ signal }) => signal,
        { signal: shared.signal },
      ),
    ).resolves.toBe(shared.signal);
  });

  it('uses the stages validated at call time, ignoring later mutation', async () => {
    const outer = valve({ id: 'snapshot-outer', concurrency: 1 });
    const inner = valve({
      id: 'snapshot-inner',
      rate: { ...minute, name: 'tenant', scope: 'tenant' },
    });
    const gate = deferred();
    const holder = outer.run(() => gate.promise);
    const options = { cost: 1, scopes: { tenant: 't1' } };
    const stages = [{ valve: outer }, { valve: inner, options }];
    const result = runSequential(stages, () => 'ran');
    // A repeated id swapped in after validation would wait on its own slot.
    stages[1] = { valve: outer, options };
    options.cost = 5;
    options.scopes.tenant = 't2';
    gate.release();
    await holder;
    await expect(result).resolves.toBe('ran');
    const tenant = (name: string) =>
      inner
        .run(() => 'admitted', { maxWait: 0, scopes: { tenant: name } })
        .then(
          () => false,
          (error: unknown) => isValveError(error, 'MAX_WAIT_EXCEEDED'),
        );
    await expect(tenant('t1')).resolves.toBe(true);
    await expect(tenant('t2')).resolves.toBe(false);
  });

  it('propagates a later stage store failure after the earlier stage admitted', async () => {
    const a = valve({ id: 'store-a', rate: minute });
    const broken = memoryStore();
    delete broken.acquireSync;
    broken.acquire = () => Promise.reject(new Error('store down'));
    const b = valve({
      id: 'store-b',
      rate: minute,
      store: broken,
      onStoreError: 'throw',
    });
    const fn = vi.fn();
    await expect(
      runSequential([{ valve: a }, { valve: b }], fn),
    ).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE', valveId: 'store-b' });
    expect(fn).not.toHaveBeenCalled();
    expect(await spent(a)).toBe(true);
  });

  it('updates managed limits per stage only', async () => {
    const managed = (id: string) =>
      valve({
        id,
        limits: 'managed',
        rate: { name: 'calls', ...minute },
      });
    const a = managed('managed-a');
    const b = managed('managed-b');
    await runSequential([{ valve: a }, { valve: b }], () => 'first');
    await b.updateLimits({ calls: { limit: 2 } });
    expect((await a.getLimits()).rules.calls).toMatchObject({ limit: 1 });
    // b has room again, but a's spent budget still blocks the sequence.
    await expect(
      runSequential(
        [{ valve: a, options: { maxWait: 0 } }, { valve: b }],
        () => 'second',
      ),
    ).rejects.toMatchObject({
      code: 'MAX_WAIT_EXCEEDED',
      valveId: 'managed-a',
    });
    await a.updateLimits({ calls: { limit: 2 } });
    await expect(
      runSequential([{ valve: a }, { valve: b }], () => 'third'),
    ).resolves.toBe('third');
  });
});
