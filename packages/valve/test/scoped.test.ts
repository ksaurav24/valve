import { scopedCases } from './scoped-cases.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createValve, memoryStore } from '../src/index.js';
import { normalize } from '../src/rules.js';
import { DelayedQueue } from '../src/delayed.js';
import type { ScopedAcquireRequest, Store } from '../src/store.js';

const rate = [
  {
    name: 'business',
    limit: 3,
    interval: 10000,
    algorithm: 'fixed-window' as const,
  },
  { name: 'spacing', scope: 'recipient', limit: 1, interval: 100 },
  {
    name: 'daily',
    scope: 'recipient',
    limit: 100,
    interval: '24h' as const,
    algorithm: 'fixed-window' as const,
  },
];
const job = (recipient: string, cost = 1) => ({ cost, scopes: { recipient } });
const request = (
  jobs = [job('A'), job('A'), job('B'), job('C')],
): ScopedAcquireRequest => ({
  id: 'scope-test',
  rules: normalize({ id: 'scope-test', rate }).rules,
  jobs,
});
afterEach(() => vi.useRealTimers());

describe('scoped atomic memory admission', () => {
  it.each(scopedCases)('$name', async ({ rate, steps }) => {
    let now = 0;
    const store = memoryStore({ clock: () => now });
    const id = 'boundaries';
    const rules = normalize({ id, rate }).rules;
    for (const step of steps) {
      now = step.now;
      expect(
        await store.acquireScoped!({ id, rules, jobs: step.jobs }),
      ).toEqual(step.expected);
    }
    await store.close();
  });
  it('names missing dimensions before queueing or accessing the store', async () => {
    const store = memoryStore();
    const acquire = vi.spyOn(store, 'acquireScopedSync');
    const api = createValve({
      id: 'missing',
      store,
      rate: [
        { name: 'tenant', scope: 'tenant', limit: 1, interval: '1s' },
        { name: 'recipient', scope: 'recipient', limit: 1, interval: '1s' },
      ],
    });
    for (const scopes of [undefined, {}, { tenant: 'T' }]) {
      await expect(
        api.run(() => 0, scopes ? { scopes } : {}),
      ).rejects.toMatchObject({
        code: 'INVALID_OPTIONS',
        message: expect.stringContaining(
          `Missing required scope identity "${scopes?.tenant ? 'recipient' : 'tenant'}"`,
        ),
      });
    }
    expect(acquire).not.toHaveBeenCalled();
    await expect(
      api.run(() => 42, { scopes: { tenant: 'T', recipient: 'A' } }),
    ).resolves.toBe(42);
    await api.close();
  });
  it('spends all budgets or none and uses intermediate state within a batch', async () => {
    let now = 1000;
    const store = memoryStore({ clock: () => now });
    expect(await store.acquireScoped!(request())).toEqual({
      grantedIndexes: [0, 2, 3],
      blocked: [{ index: 1, retryAfterMs: 100 }],
    });
    now += 100;
    expect(
      (await store.acquireScoped!(request([job('A')]))).grantedIndexes,
    ).toEqual([]);
    now = 10000;
    expect(
      (await store.acquireScoped!(request([job('A')]))).grantedIndexes,
    ).toEqual([0]);
  });
  it('admits lower-cost jobs after an expensive denial without spending its other budgets', async () => {
    const store = memoryStore({ clock: () => 0 });
    const rules = normalize({
      id: 'weighted',
      rate: [
        { limit: 3, interval: 1000, algorithm: 'fixed-window' },
        {
          name: 'recipient',
          scope: 'recipient',
          limit: 10,
          burst: 10,
          interval: 1000,
        },
      ],
    }).rules;
    const result = await store.acquireScoped!({
      id: 'weighted',
      rules,
      jobs: [job('A', 2), job('B', 2), job('B')],
    });
    expect(result.grantedIndexes).toEqual([0, 2]);
    expect(result.blocked).toEqual([{ index: 1, retryAfterMs: 1000 }]);
  });
  it('pins policy independently of expiry and ignores rule order', async () => {
    let now = 0;
    const store = memoryStore({ clock: () => now });
    const req = request([job('A')]);
    await store.acquireScoped!(req);
    now = 100000000;
    await expect(
      store.acquireScoped!({ ...req, rules: [...req.rules].reverse() }),
    ).resolves.toMatchObject({ grantedIndexes: [0] });
    expect(() =>
      store.acquireScopedSync!({
        ...req,
        rules: req.rules.map((r) => ({ ...r, limit: r.limit + 1 })),
      }),
    ).toThrow(/configuration/);
  });
  it('issues sparse leases, renews, releases and expires them', async () => {
    let now = 1000;
    const store = memoryStore({ clock: () => now });
    const req = { ...request(), lease: { limit: 2, ttlMs: 300, owner: 'one' } };
    const result = await store.acquireScoped!(req);
    expect(result.grantedIndexes).toEqual([0, 2]);
    expect(result.leases).toEqual([
      { index: 0, token: 'one:0' },
      { index: 2, token: 'one:2' },
    ]);
    expect(await store.renew!(req.id, ['one:0'], 300)).toBe(true);
    await store.release!(req.id, ['one:2']);
    expect(
      (
        await store.acquireScoped!({
          ...req,
          jobs: [job('C')],
          lease: { ...req.lease, owner: 'two' },
        })
      ).grantedIndexes,
    ).toEqual([0]);
    now += 400;
    expect(await store.renew!(req.id, ['one:0'], 300)).toBe(false);
  });
  it('checks shared pauses without spending rate or leases', async () => {
    const store = memoryStore({ clock: () => 1000 });
    await store.pause('scope-test', 500);
    expect((await store.acquireScoped!(request())).grantedIndexes).toEqual([]);
    await store.resume('scope-test');
    expect((await store.acquireScoped!(request())).grantedIndexes).toEqual([
      0, 2, 3,
    ]);
  });
});

describe('scoped scheduler and wrappers', () => {
  it('lets B and C pass A2, then wakes A2 with one eligibility timer', async () => {
    vi.useFakeTimers();
    const api = createValve({ id: 'sparse', rate: rate.slice(1) });
    const started: string[] = [];
    const runs = ['A', 'A', 'B', 'C'].map((recipient, i) =>
      api.run(() => started.push(`${recipient}${i}`), {
        scopes: { recipient },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(['A0', 'B2', 'C3']);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all(runs);
    expect(started).toEqual(['A0', 'B2', 'C3', 'A1']);
    await api.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('handles priorities, cancellation, maxWait and queue limits while delayed', async () => {
    vi.useFakeTimers();
    const api = createValve({ id: 'life', rate: rate.slice(1), maxQueue: 4 });
    const abort = new AbortController();
    const started: string[] = [];
    const first = api.run(() => started.push('A'), {
      scopes: { recipient: 'A' },
      priority: 10,
    });
    const cancelled = api
      .run(() => started.push('bad'), {
        scopes: { recipient: 'A' },
        signal: abort.signal,
      })
      .catch((e) => e.code);
    const timeout = api
      .run(() => started.push('bad'), {
        scopes: { recipient: 'A' },
        maxWait: 20,
      })
      .catch((e) => e.code);
    const other = api.run(() => started.push('B'), {
      scopes: { recipient: 'B' },
      priority: 1,
    });
    await expect(
      api.run(() => 0, { scopes: { recipient: 'C' } }),
    ).rejects.toMatchObject({ code: 'QUEUE_FULL' });
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(['A', 'B']);
    abort.abort();
    await vi.advanceTimersByTimeAsync(20);
    expect(await cancelled).toBe('ABORTED');
    expect(await timeout).toBe('MAX_WAIT_EXCEEDED');
    await Promise.all([first, other]);
    await api.idle();
    await api.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('admits zero maxWait scoped jobs once and rejects blocked ones', async () => {
    vi.useFakeTimers();
    const api = createValve({ id: 'zero', rate: rate.slice(1) });
    const scopes = { recipient: 'A' };
    expect(await api.run(() => 'A', { scopes, maxWait: 0 })).toBe('A');
    await expect(
      api.run(() => 'again', { scopes, maxWait: 0 }),
    ).rejects.toMatchObject({ code: 'MAX_WAIT_EXCEEDED' });
    expect(api.stats().queued).toBe(0);
    await api.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('snapshots identities and resolves fetch scopes once across retries', async () => {
    vi.useFakeTimers();
    const api = createValve({
      id: 'retry',
      rate: rate.slice(1),
      backoff: { base: 1, max: 1 },
    });
    const identities = { recipient: 'A' };
    const resolver = vi.fn(() => identities);
    const fetcher = vi.fn(async () => ({
      status: fetcher.mock.calls.length === 1 ? 429 : 200,
      headers: {},
    }));
    const result = api.wrapFetch(fetcher, { scopes: resolver })();
    await vi.advanceTimersByTimeAsync(0);
    identities.recipient = 'B';
    await vi.advanceTimersByTimeAsync(99);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).status).toBe(200);
    expect(resolver).toHaveBeenCalledTimes(1);
    await api.close();
  });
  it('resumes delayed jobs after a shared pause and supports fixed wrap scopes', async () => {
    vi.useFakeTimers();
    const store = memoryStore();
    const api = createValve({ id: 'pause', rate: rate.slice(1), store });
    await store.pause(api.id, 10000);
    const wrapped = api.wrap((n: number) => n * 2, {
      scopes: { recipient: 'A' },
    });
    const result = wrapped(3);
    await vi.advanceTimersByTimeAsync(0);
    await api.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe(6);
    await api.close();
  });
  it('fails explicitly on invalid identities and unsupported stores', async () => {
    const api = createValve({ id: 'validation', rate });
    for (const scopes of [
      undefined,
      {},
      { recipient: '' },
      { recipient: 'A', typo: 'B' },
      Object.create({ recipient: 'A' }),
      { recipient: '\ud800' },
      { recipient: 'a'.repeat(257) },
    ])
      await expect(api.run(() => 0, { scopes })).rejects.toMatchObject({
        code: 'INVALID_OPTIONS',
      });
    const store = {
      ...memoryStore(),
      acquireScoped: undefined,
    } as unknown as Store;
    expect(() => createValve({ id: 'unsupported', rate, store })).toThrow(
      /acquireScoped/,
    );
    expect(() =>
      createValve({
        id: 'unnamed',
        rate: { scope: 'recipient', limit: 1, interval: 100 },
      }),
    ).toThrow(/name/);
    expect(() => createValve({ id: 'big', rate, batch: 129 })).toThrow(/128/);
    await api.close();
  });
  it('rejects queued scoped work on close and drains when requested', async () => {
    vi.useFakeTimers();
    const api = createValve({ id: 'close', rate: rate.slice(1) });
    const first = api.run(() => 1, { scopes: { recipient: 'A' } });
    const second = api
      .run(() => 2, { scopes: { recipient: 'A' } })
      .catch((e) => e.code);
    await vi.advanceTimersByTimeAsync(0);
    await api.close();
    expect(await first).toBe(1);
    expect(await second).toBe('CLOSED');
    expect(vi.getTimerCount()).toBe(0);
    const drain = createValve({ id: 'drain', rate: rate.slice(1) });
    const jobs = [1, 2].map((i) =>
      drain.run(() => i, { scopes: { recipient: 'A' } }),
    );
    const closing = drain.close({ drain: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(await Promise.all(jobs)).toEqual([1, 2]);
    await closing;
  });
});

it('removes arbitrary delayed entries without breaking ordering', () => {
  const queue = new DelayedQueue<{ seq: number }>();
  const jobs = Array.from({ length: 1000 }, (_, seq) => ({ seq }));
  for (const job of jobs) queue.add(job, (job.seq * 31) % 101);
  for (const job of jobs) if (job.seq % 3 === 0) queue.remove(job);
  const expected = jobs
    .filter((j) => j.seq % 3 !== 0)
    .sort(
      (a, b) => ((a.seq * 31) % 101) - ((b.seq * 31) % 101) || a.seq - b.seq,
    );
  expect(queue.take(Infinity, 1000)).toEqual(expected);
  expect(queue.size).toBe(0);
});

describe('scoped async stores and failures', () => {
  function asyncStore(): Store {
    const store = memoryStore();
    delete store.acquireScopedSync;
    return store;
  }
  it('uses async sparse grants with global concurrency and renews running jobs', async () => {
    vi.useFakeTimers();
    const store = asyncStore();
    const renew = vi.spyOn(store, 'renew');
    const api = createValve({
      id: 'async-global',
      rate: rate.slice(1),
      store,
      concurrency: { limit: 2, scope: 'global', leaseTtl: 60 },
    });
    let active = 0;
    let peak = 0;
    const runs = ['A', 'A', 'B', 'C'].map((recipient) =>
      api.run(
        async () => {
          peak = Math.max(peak, ++active);
          await new Promise((resolve) => setTimeout(resolve, 90));
          active--;
        },
        { scopes: { recipient } },
      ),
    );
    await vi.advanceTimersByTimeAsync(400);
    await Promise.all(runs);
    expect(peak).toBe(2);
    expect(renew).toHaveBeenCalled();
    await api.close();
  });
  it.each(['wait', 'throw', 'open'] as const)(
    'applies %s to an async outage',
    async (policy) => {
      vi.useFakeTimers();
      const store = asyncStore();
      const acquire = store.acquireScoped!.bind(store);
      store.acquireScoped = vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockImplementation(acquire);
      const api = createValve({
        id: 'outage',
        rate,
        store,
        onStoreError: policy,
      });
      const result = api
        .run(() => 42, { scopes: { recipient: 'A' } })
        .catch((e) => e.code);
      await vi.advanceTimersByTimeAsync(500);
      expect(await result).toBe(policy === 'throw' ? 'STORE_UNAVAILABLE' : 42);
      await api.close();
    },
  );
  it('handles synchronous throws from an async store capability', async () => {
    const store = asyncStore();
    store.acquireScoped = () => {
      throw new Error('offline');
    };
    const api = createValve({
      id: 'sync-throw',
      rate,
      store,
      onStoreError: 'throw',
    });
    await expect(
      api.run(() => 1, { scopes: { recipient: 'A' } }),
    ).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
    await api.close();
  });
  it('rejects malformed sparse responses', async () => {
    const store = asyncStore();
    store.acquireScoped = async () => ({ grantedIndexes: [0, 0], blocked: [] });
    const api = createValve({
      id: 'malformed',
      rate,
      store,
      onStoreError: 'throw',
    });
    await expect(
      api.run(() => 1, { scopes: { recipient: 'A' } }),
    ).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
    await api.close();
  });
  it('releases a late grant after cancellation and refuses expired leases', async () => {
    vi.useFakeTimers();
    const store = asyncStore();
    const acquire = store.acquireScoped!.bind(store);
    store.acquireScoped = async (req) => {
      const result = await acquire(req);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return result;
    };
    const release = vi.spyOn(store, 'release');
    const api = createValve({
      id: 'late',
      rate: rate.slice(1),
      store,
      concurrency: { limit: 2, scope: 'global', leaseTtl: 60 },
    });
    const controller = new AbortController();
    const cancelled = api
      .run(() => 1, { scopes: { recipient: 'A' }, signal: controller.signal })
      .catch((e) => e.code);
    const expired = api
      .run(() => 2, { scopes: { recipient: 'B' } })
      .catch((e) => e.code);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(150);
    expect(await cancelled).toBe('ABORTED');
    expect(await expired).toBe('LEASE_LOST');
    expect(release).toHaveBeenCalled();
    await api.close();
  });
  it('rechecks a denial when resume arrives during acquisition', async () => {
    vi.useFakeTimers();
    const store = asyncStore();
    await store.pause('notice', 10000);
    const acquire = store.acquireScoped!.bind(store);
    store.acquireScoped = async (req) => {
      const result = await acquire(req);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return result;
    };
    const api = createValve({ id: 'notice', rate, store });
    const result = api.run(() => 1, { scopes: { recipient: 'A' } });
    await vi.advanceTimersByTimeAsync(1);
    await store.resume('notice');
    await vi.advanceTimersByTimeAsync(30);
    expect(await result).toBe(1);
    await api.close();
  });
});

it('rejects malformed direct store inputs before spending any budget', () => {
  const store = memoryStore({ clock: () => 0 });
  const valid = request([job('A')]);
  const invalid = [
    { ...valid, id: '{bad}' },
    { ...valid, jobs: [] },
    { ...valid, rules: [] },
    { ...valid, rules: [{ ...valid.rules[0]!, limit: 0 }] },
    { ...valid, rules: [{ ...valid.rules[1]!, name: '!' }] },
    { ...valid, rules: [{ ...valid.rules[1]!, name: undefined }] },
    { ...valid, rules: [valid.rules[1]!, valid.rules[1]!] },
    { ...valid, rules: [valid.rules[0]!] },
    { ...valid, rules: [{ ...valid.rules[1]!, key: 'bad' }] },
    { ...valid, lease: { limit: 0, ttlMs: 300, owner: 'x' } },
    { ...valid, jobs: [job('A', 0)] },
    { ...valid, jobs: [job('A', 2)] },
  ];
  for (const req of invalid)
    expect(() =>
      store.acquireScopedSync!(req as ScopedAcquireRequest),
    ).toThrow();
  expect(store.acquireScopedSync!(valid).grantedIndexes).toEqual([0]);
  expect(() =>
    createValve({
      id: 'bad-name',
      rate: { name: '!', limit: 1, interval: 100 },
    }),
  ).toThrow();
  expect(() =>
    createValve({
      id: 'duplicate',
      rate: [
        { name: 'same', limit: 1, interval: 100 },
        { name: 'same', limit: 1, interval: 200 },
      ],
    }),
  ).toThrow(/Duplicate/);
});

it('sweeps inactive scoped state with bounded work', async () => {
  let now = 0;
  const store = memoryStore({ clock: () => now });
  const req = request([job('A')]);
  for (let i = 0; i < 260; i++) {
    now += 10000;
    await store.acquireScoped!({ ...req, jobs: [job(String(i))] });
  }
  expect(
    (await store.acquireScoped!({ ...req, jobs: [job('new')] })).grantedIndexes,
  ).toEqual([0]);
  await store.close();
});

it('invalidates old delay hints without rechecking newly denied jobs', () => {
  const queue = new DelayedQueue<{ seq: number }>();
  const first = { seq: 0 },
    second = { seq: 1 };
  queue.add(first, 10000);
  queue.add(second, 10000);
  queue.wake();
  expect(queue.take(0, 1)).toEqual([first]);
  queue.add(first, 100);
  expect(queue.take(0, 1)).toEqual([second]);
  expect(queue.take(0, 1)).toEqual([]);
  expect(queue.next).toBe(100);
});

it('rejects static/scoped policy mixing in either order in a shared memory store', () => {
  for (const firstScoped of [true, false]) {
    const store = memoryStore({ clock: () => 0 });
    const scoped = () => store.acquireScopedSync!(request([job('A')]));
    const plain = () =>
      store.acquireSync!({
        id: 'scope-test',
        rules: normalize({
          id: 'scope-test',
          rate: { limit: 1, interval: 1000 },
        }).rules,
        costs: [1],
      });
    if (firstScoped) {
      scoped();
      expect(plain).toThrow(/mix/);
    } else {
      plain();
      expect(scoped).toThrow(/mix/);
    }
  }
});

it('atomically enforces two dimensions and same-interval named rules', async () => {
  const store = memoryStore({ clock: () => 0 });
  const id = 'two-dimensions';
  const rules = normalize({
    id,
    rate: [
      {
        name: 'tenant',
        scope: 'tenant',
        limit: 2,
        interval: 1000,
        algorithm: 'fixed-window',
      },
      {
        name: 'recipient',
        scope: 'recipient',
        limit: 1,
        interval: 1000,
        algorithm: 'fixed-window',
      },
    ],
  }).rules;
  const jobs = [
    ['T1', 'A'],
    ['T2', 'A'],
    ['T2', 'B'],
    ['T2', 'C'],
  ].map(([tenant, recipient]) => ({
    cost: 1,
    scopes: { tenant: tenant!, recipient: recipient! },
  }));
  // T2/A is denied by recipient A without spending tenant T2's budget.
  expect(
    (await store.acquireScoped!({ id, rules, jobs })).grantedIndexes,
  ).toEqual([0, 2, 3]);
});

it('prioritizes all eligible delayed jobs across batch boundaries', async () => {
  vi.useFakeTimers();
  const backing = memoryStore();
  const store: Store = {
    ...backing,
    acquireScoped: async (req: ScopedAcquireRequest) => {
      if (Date.now() < 100)
        return {
          grantedIndexes: [],
          blocked: req.jobs.map((_, index) => ({
            index,
            retryAfterMs: 100 - Date.now(),
          })),
        };
      return backing.acquireScoped!(req);
    },
  };
  delete store.acquireScopedSync;
  vi.setSystemTime(0);
  const api = createValve({
    id: 'eligible-priority',
    rate: rate.slice(1),
    store,
    batch: 2,
  });
  const started: number[] = [];
  const jobs = Array.from({ length: 6 }, (_, i) =>
    api.run(() => started.push(i), { scopes: { recipient: String(i) } }),
  );
  await vi.advanceTimersByTimeAsync(0);
  jobs.push(
    api.run(() => started.push(99), {
      scopes: { recipient: 'high' },
      priority: 10,
    }),
  );
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(100);
  await Promise.all(jobs);
  expect(started).toEqual([99, 0, 1, 2, 3, 4, 5]);
  await api.close();
});

it('skips high-priority delayed identities across batches and cancels all their timers', async () => {
  vi.useFakeTimers();
  const api = createValve({
    id: 'cancel-batches',
    rate: rate.slice(1),
    batch: 2,
  });
  const seed = api.run(() => 0, { scopes: { recipient: 'A' } });
  await vi.advanceTimersByTimeAsync(0);
  await seed;
  const controller = new AbortController();
  const blocked = vi.fn();
  const jobs = Array.from({ length: 6 }, () =>
    api
      .run(blocked, {
        scopes: { recipient: 'A' },
        priority: 10,
        signal: controller.signal,
      })
      .catch((error) => error.code),
  );
  const ready = api.run(() => 'B', { scopes: { recipient: 'B' } });
  await vi.advanceTimersByTimeAsync(0);
  expect(await ready).toBe('B');
  expect(blocked).not.toHaveBeenCalled();
  controller.abort();
  expect(await Promise.all(jobs)).toEqual(Array(6).fill('ABORTED'));
  await vi.advanceTimersByTimeAsync(100);
  expect(blocked).not.toHaveBeenCalled();
  await api.close();
  expect(vi.getTimerCount()).toBe(0);
});

it('retains static policy ownership through pause, counter cleanup and close', async () => {
  let now = 0;
  const store = memoryStore({ clock: () => now });
  const id = 'static-owner';
  const rules = normalize({ id, rate: { limit: 1, interval: 10 } }).rules;
  const scoped = { ...request([job('A')]), id };
  await store.pause(id, 100);
  expect(store.acquireSync!({ id, rules, costs: [1] }).granted).toBe(0);
  expect(() => store.acquireScopedSync!(scoped)).toThrow(/Cannot mix/);
  now = 100;
  expect(store.acquireSync!({ id, rules, costs: [1] }).granted).toBe(1);
  now = 1000;
  // Trigger the static sweeper after the original rate state has expired.
  for (let i = 0; i < 1024; i++)
    store.acquireSync!({ id: 'sweep', rules: [], costs: [1] });
  expect(() => store.acquireScopedSync!(scoped)).toThrow(/Cannot mix/);
  await store.close();
  expect(store.acquireScopedSync!(scoped).grantedIndexes).toEqual([0]);
  await store.close();
});
