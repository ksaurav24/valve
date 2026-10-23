// Independent keyed groups: isolation, stable ids, bounded lifecycle, and managed limits.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isValveError, memoryStore } from '../src/index.js';
import type { Store } from '../src/index.js';
import { createValveGroup } from '../src/group/index.js';
import type { ValveGroup, ValveGroupOptions } from '../src/group/index.js';

const minute = { limit: 1, interval: '1m', algorithm: 'fixed-window' } as const;
const opened: ValveGroup[] = [];
const group = <K extends string = string>(options: ValveGroupOptions<K>) => {
  const created = createValveGroup(options);
  opened.push(created as unknown as ValveGroup);
  return created;
};
const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
};
const until = async (ready: () => boolean) => {
  for (let i = 0; i < 300 && !ready(); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(ready()).toBe(true);
};
const spent = (g: ValveGroup, key: string) =>
  g
    .run(key, () => 'admitted', { maxWait: 0 })
    .then(
      () => false,
      (error: unknown) => isValveError(error, 'MAX_WAIT_EXCEEDED'),
    );
/** A memory store that counts live subscriptions, one per local child valve. */
const counted = () => {
  const store = memoryStore();
  const live = new Map<string, number>();
  let peak = 0;
  const subscribe = store.subscribe!.bind(store);
  store.subscribe = (id, listener) => {
    live.set(id, (live.get(id) ?? 0) + 1);
    peak = Math.max(
      peak,
      [...live.values()].reduce((a, b) => a + b, 0),
    );
    if (live.get(id)! > 1) throw new Error(`two live valves for ${id}`);
    const off = subscribe(id, listener) as () => void;
    return () => {
      live.set(id, live.get(id)! - 1);
      if (!live.get(id)) live.delete(id);
      off();
    };
  };
  return {
    store,
    live,
    get peak() {
      return peak;
    },
  };
};
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(opened.splice(0).map((g) => g.close()));
});

describe('createValveGroup identity', () => {
  it('maps keys to stable, encoded, collision-free valve ids', () => {
    const tenants = group({
      id: 'crm:tenants',
      resolve: () => ({ rate: minute }),
    });
    expect(tenants.get('tenant-42').id).toBe('crm:tenants:tenant-42');
    expect(tenants.get('a:b').id).toBe('crm:tenants:a%3Ab');
    expect(tenants.get('{x}').id).toBe('crm:tenants:%7Bx%7D');
    expect(tenants.get('%3A').id).toBe('crm:tenants:%253A');
    // A colon key in one group never meets a nested group id.
    const outer = group({ id: 'a', resolve: () => ({ rate: minute }) });
    const inner = group({ id: 'a:b', resolve: () => ({ rate: minute }) });
    expect(outer.get('b:c').id).not.toBe(inner.get('c').id);
  });

  it('keeps keys whose ids differ only by encoding independent', async () => {
    const store = memoryStore();
    const a = group({ id: 'a', store, resolve: () => ({ rate: minute }) });
    const ab = group({ id: 'a:b', store, resolve: () => ({ rate: minute }) });
    await a.run('b:c', () => 1);
    expect(await spent(ab, 'c')).toBe(false);
    expect(await spent(a, 'b%3Ac')).toBe(false);
    expect(await spent(a, 'b:c')).toBe(true);
    await store.close();
  });

  it('rejects invalid group options', () => {
    const resolve = () => ({ rate: minute });
    for (const id of ['', 'x'.repeat(199), '{a}', 5 as unknown as string])
      expect(() => createValveGroup({ id, resolve })).toThrow(
        expect.objectContaining({ code: 'INVALID_OPTIONS' }),
      );
    expect(() =>
      createValveGroup({ id: 'g', resolve: undefined as never }),
    ).toThrow(/resolve must be a function/);
    for (const maxSize of [0, 1.5, Infinity])
      expect(() => createValveGroup({ id: 'g', resolve, maxSize })).toThrow(
        /maxSize/,
      );
    for (const maxPending of [0, 1.5, Infinity])
      expect(() => createValveGroup({ id: 'g', resolve, maxPending })).toThrow(
        /maxPending/,
      );
    expect(() => createValveGroup({ id: 'g', resolve, idleTtl: -1 })).toThrow(
      /idleTtl/,
    );
    expect(() => createValveGroup(undefined as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_OPTIONS' }),
    );
  });

  it('rejects invalid keys without printing them or creating a valve', async () => {
    const resolve = vi.fn(() => ({ rate: minute }));
    const g = group({ id: 'g', resolve });
    for (const key of ['', 'x'.repeat(199), '\ud800', 7 as unknown as string]) {
      expect(() => g.get(key)).toThrow(
        expect.objectContaining({ code: 'INVALID_OPTIONS' }),
      );
      await expect(g.run(key, () => 1)).rejects.toMatchObject({
        code: 'INVALID_OPTIONS',
      });
    }
    expect(() => g.get('secret-'.repeat(30))).toThrow(/210 characters/);
    expect(() => g.get('secret-'.repeat(30))).not.toThrow(/secret/);
    expect(g.get('x'.repeat(198)).id).toHaveLength(200);
    expect(resolve).not.toHaveBeenCalled();
    expect(g.stats()).toEqual({ size: 0, active: 0 });
  });

  it('rejects resolver results that set id or store, are async, or not objects, without caching', async () => {
    const results: unknown[] = [
      { rate: minute, id: 'other' },
      { rate: minute, store: memoryStore() },
      Promise.resolve({ rate: minute }),
      null,
      'rate',
    ];
    const resolve = vi.fn(() =>
      results.length ? results.shift() : { rate: minute },
    );
    const g = group({ id: 'g', resolve: resolve as never });
    for (let i = 0; i < 5; i++)
      await expect(g.run('k', () => 1)).rejects.toMatchObject({
        code: 'INVALID_OPTIONS',
      });
    expect(g.stats().size).toBe(0);
    await expect(g.run('k', () => 'ok')).resolves.toBe('ok');
    expect(resolve).toHaveBeenCalledTimes(6);
  });

  it('passes resolver and createValve errors through without caching', async () => {
    let fail = true;
    const g = group({
      id: 'g',
      resolve: () => {
        if (fail) throw new Error('tier lookup failed');
        return { rate: minute };
      },
    });
    await expect(g.run('k', () => 1)).rejects.toThrow('tier lookup failed');
    fail = false;
    const bad = group({ id: 'bad', resolve: () => ({}) });
    await expect(bad.run('k', () => 1)).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    });
    expect(bad.stats().size).toBe(0);
    await expect(g.run('k', () => 2)).resolves.toBe(2);
  });

  it('copies resolver options, so later mutation changes nothing', async () => {
    const shared = { rate: { ...minute, limit: 1 }, maxQueue: 5 };
    const g = group({ id: 'g', resolve: () => shared });
    await g.run('k', () => 1);
    shared.rate.limit = 100;
    shared.maxQueue = 0;
    expect(await spent(g, 'k')).toBe(true);
  });
});

describe('createValveGroup isolation', () => {
  it('gives each key its own budget, and one key one budget across workers', async () => {
    const store = memoryStore();
    const resolve = () => ({ rate: minute });
    const workerA = group({ id: 'tenants', store, resolve });
    const workerB = group({ id: 'tenants', store, resolve });
    await workerA.run('t1', () => 1);
    expect(await spent(workerA, 't2')).toBe(false);
    expect(await spent(workerB, 't1')).toBe(true);
    expect(await spent(workerB, 't3')).toBe(false);
    await workerA.close();
    await workerB.close();
    await store.close();
  });

  it('resolves per-key tiers and scopes jobs normally', async () => {
    const tier = (key: string) => (key.startsWith('pro') ? 3 : 1);
    const g = group({
      id: 'tiers',
      resolve: (key) => ({
        rate: { name: 'user', scope: 'user', ...minute, limit: tier(key) },
      }),
    });
    for (const user of ['u1', 'u2', 'u3'])
      await g.run('pro-1', () => 1, { scopes: { user } });
    await g.run('pro-1', () => 1, { scopes: { user: 'u1' } }).catch(() => {});
    await expect(
      g.run('free-1', () => 1, { scopes: { user: 'u1' } }),
    ).resolves.toBe(1);
    expect(
      await g
        .run('free-1', () => 1, { scopes: { user: 'u2' } })
        .then(() => 'ran'),
    ).toBe('ran');
    await expect(
      g.run('free-1', () => 1, { scopes: { user: 'u1' }, maxWait: 0 }),
    ).rejects.toMatchObject({ code: 'MAX_WAIT_EXCEEDED' });
    await expect(g.run('free-1', () => 1)).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    });
  });

  it('keeps pauses, feedback cooldowns and concurrency per key', async () => {
    const g = group({ id: 'p', resolve: () => ({ concurrency: 1 }) });
    const pauses: string[] = [];
    g.on('pause', (_event, key) => pauses.push(key));
    g.get('a').observe({ status: 429, headers: { 'retry-after': '60' } });
    await until(() => pauses.length > 0);
    // The store may echo the pause back with reason "store"; both belong to a.
    expect(new Set(pauses)).toEqual(new Set(['a']));
    await expect(g.run('b', () => 'b', { maxWait: 50 })).resolves.toBe('b');
    await expect(g.run('a', () => 'a', { maxWait: 20 })).rejects.toMatchObject({
      code: 'MAX_WAIT_EXCEEDED',
    });
    const gate = deferred();
    const running = g.run('c', () => gate.promise);
    await expect(g.run('d', () => 'd')).resolves.toBe('d');
    await expect(g.run('c', () => 'c2', { maxWait: 10 })).rejects.toMatchObject(
      { code: 'MAX_WAIT_EXCEEDED' },
    );
    gate.release();
    await running;
    await g.get('a').resume();
    await expect(g.run('a', () => 'a')).resolves.toBe('a');
  });

  it('supports cost, priority, wrap and abort on each key', async () => {
    const g = group({
      id: 'w',
      resolve: () => ({
        rate: { limit: 3, interval: '1m', burst: 3 },
        concurrency: 1,
      }),
    });
    const member = g.get('k');
    const double = member.wrap((n: number) => n * 2);
    await expect(double(4)).resolves.toBe(8);
    await expect(member.run(() => 'all', { cost: 2 })).resolves.toBe('all');
    await expect(member.run(() => 1, { cost: 4 })).rejects.toMatchObject({
      code: 'COST_EXCEEDS_LIMIT',
    });
    const controller = new AbortController();
    const order: number[] = [];
    const blocker = deferred();
    const first = g.run('p', () => blocker.promise);
    const low = g.run('p', () => order.push(1), { priority: 0 });
    const high = g.run('p', () => order.push(2), { priority: 5 });
    const aborted = g.run('p', () => order.push(3), {
      signal: controller.signal,
    });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: 'ABORTED' });
    blocker.release();
    await Promise.all([first, low, high]);
    expect(order).toEqual([2, 1]);
    expect(g.stats().active).toBe(0);
  });

  it('passes job errors through and releases the key', async () => {
    const g = group({ id: 'e', resolve: () => ({ concurrency: 1 }) });
    await expect(
      g.run('k', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(
      g.run('k', () => Promise.reject(new Error('async boom'))),
    ).rejects.toThrow('async boom');
    expect(g.stats()).toEqual({ size: 1, active: 0 });
  });

  it('routes wrapFetch through the key and holds it across retries', async () => {
    const g = group({
      id: 'f',
      idleTtl: 0,
      resolve: () => ({ concurrency: 1, backoff: { base: 20, max: 20 } }),
    });
    const calls: string[] = [];
    const statuses = [429, 200];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      return { status: statuses.shift()!, headers: {} };
    };
    const limited = g.get('model-a').wrapFetch(fetchImpl, { retries: 1 });
    const response = await limited('https://api.example/a');
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    await expect(
      g.get('model-a').wrapFetch(fetchImpl, { retries: -1 })('x'),
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
  });
});

describe('createValveGroup lifecycle', () => {
  it('creates one valve for concurrent first calls of a key', async () => {
    const resolve = vi.fn(() => ({ concurrency: 2 }));
    const g = group({ id: 'c', resolve });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => g.run('k', () => i)),
    );
    expect(results).toHaveLength(20);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(g.stats().size).toBe(1);
  });

  it('evicts idle valves after idleTtl and keeps store state', async () => {
    const { store, live } = counted();
    const resolve = vi.fn(() => ({ rate: minute }));
    const g = group({ id: 'ttl', store, idleTtl: 20, resolve });
    await g.run('k', () => 1);
    const member = g.get('k');
    expect(member.stats()).toMatchObject({ queued: 0, running: 0 });
    await until(() => g.stats().size === 0);
    expect(live.size).toBe(0);
    expect(member.stats()).toBeUndefined();
    // The recreated valve continues the spent budget.
    expect(await spent(g, 'k')).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('never evicts a valve with work in progress, and evicts it once settled', async () => {
    const g = group({
      id: 'busy',
      idleTtl: 0,
      resolve: () => ({ concurrency: 1 }),
    });
    const gate = deferred();
    const running = g.run('k', () => gate.promise);
    const queued = g.run('k', () => 'queued');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(g.stats()).toEqual({ size: 1, active: 1 });
    gate.release();
    await expect(queued).resolves.toBe('queued');
    await running;
    await until(() => g.stats().size === 0);
  });

  it('keeps a paused valve until its pause ends', async () => {
    const g = group({
      id: 'paused',
      idleTtl: 0,
      resolve: () => ({ concurrency: 1 }),
    });
    await g.get('k').pause('120ms');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(g.stats().size).toBe(1);
    await until(() => g.stats().size === 0);
  });

  it('evicts the least recently used idle valve when full', async () => {
    const { store, live } = counted();
    const g = group({
      id: 'lru',
      store,
      maxSize: 2,
      resolve: () => ({ concurrency: 1 }),
    });
    await g.run('a', () => 1);
    await g.run('b', () => 1);
    await g.run('a', () => 1);
    await g.run('c', () => 1);
    expect([...live.keys()].sort()).toEqual(['lru:a', 'lru:c']);
    expect(g.get('b').stats()).toBeUndefined();
    expect(g.stats().size).toBe(2);
  });

  it('rejects with QUEUE_FULL when every valve is busy, without exceeding maxSize', async () => {
    const { store } = counted();
    const g = group({
      id: 'full',
      store,
      maxSize: 2,
      resolve: () => ({ concurrency: 1 }),
    });
    const gates = [deferred(), deferred()];
    const busy = ['a', 'b'].map((key, i) =>
      g.run(key, () => gates[i]!.promise),
    );
    await expect(g.run('c', () => 1)).rejects.toMatchObject({
      code: 'QUEUE_FULL',
      valveId: 'full',
    });
    // Existing keys still accept work at capacity.
    const more = g.run('a', () => 'more');
    expect(g.stats().size).toBe(2);
    gates[0]!.release();
    await busy[0];
    await more;
    await expect(g.run('c', () => 'c')).resolves.toBe('c');
    gates[1]!.release();
    await busy[1];
    expect(g.stats().size).toBe(2);
  });

  it('never has two valves for one key or more than maxSize under churn', async () => {
    const counter = counted();
    const resolve = vi.fn(() => ({ concurrency: 2 }));
    const g = group({
      id: 'churn',
      store: counter.store,
      maxSize: 8,
      idleTtl: 1,
      resolve,
    });
    let rejected = 0;
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 2000; i++) {
      const key = `k${(i * 7919) % 50}`;
      jobs.push(
        g
          .run(key, () => new Promise((r) => setTimeout(r, i % 3)))
          .catch((error: unknown) => {
            if (!isValveError(error, 'QUEUE_FULL')) throw error;
            rejected++;
          }),
      );
      if (i % 25 === 0) await new Promise((r) => setTimeout(r, 1));
    }
    await Promise.all(jobs);
    expect(counter.peak).toBeLessThanOrEqual(8);
    expect(g.stats().size).toBeLessThanOrEqual(8);
    expect(g.stats().active).toBe(0);
    expect(resolve.mock.calls.length).toBeGreaterThan(8);
    expect(rejected).toBeLessThan(2000);
    await g.close();
    expect(counter.live.size).toBe(0);
  });

  it('makes later calls for an evicting key wait for the close', async () => {
    const counter = counted();
    const store = counter.store;
    const resolve = vi.fn(() => ({
      concurrency: { limit: 1, scope: 'global' as const },
    }));
    // Delay lease cleanup so the eviction close stays pending.
    const release = store.release!.bind(store);
    const hold = deferred();
    let held = false;
    store.release = async (...args) => {
      if (!held) {
        held = true;
        await hold.promise;
      }
      return release(...args);
    };
    const g = group({ id: 'evicting', store, idleTtl: 0, resolve });
    await g.run('a', () => 1);
    // The sweep starts closing the idle valve, which waits for the held release.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(held).toBe(true);
    expect(g.stats().size).toBe(1);
    const again = g.run('a', () => 'again');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resolve).toHaveBeenCalledTimes(1);
    hold.release();
    await expect(again).resolves.toBe('again');
    expect(counter.peak).toBe(1);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('starts calls in call order, for new keys and while waiting for room', async () => {
    const store = memoryStore();
    const release = store.release!.bind(store);
    const hold = deferred();
    let holding = false;
    store.release = async (...args) => {
      if (holding) await hold.promise;
      return release(...args);
    };
    const g = group({
      id: 'order',
      store,
      maxSize: 1,
      resolve: () => ({
        concurrency: { limit: 1, scope: 'global' as const },
      }),
    });
    const order: string[] = [];
    await Promise.all(
      ['a1', 'a2', 'a3'].map((name) => g.run('a', () => order.push(name))),
    );
    expect(order).toEqual(['a1', 'a2', 'a3']);
    // Key b must wait for a's valve to close; later calls for b and a queue behind.
    holding = true;
    const calls = [
      g.run('b', () => order.push('b1')),
      g.run('b', () => order.push('b2')),
    ];
    await new Promise((resolve) => setTimeout(resolve, 5));
    calls.push(g.run('b', () => order.push('b3')));
    hold.release();
    await Promise.all(calls);
    expect(order.slice(3)).toEqual(['b1', 'b2', 'b3']);
    await g.close();
    await store.close();
  });

  it('keeps a member usable across evictions', async () => {
    const g = group({
      id: 'member',
      idleTtl: 0,
      resolve: () => ({ concurrency: 1 }),
    });
    const member = g.get('k');
    await member.run(() => 1);
    await until(() => g.stats().size === 0);
    await expect(member.run(() => 2)).resolves.toBe(2);
  });

  it('isolates a throwing listener from the others', async () => {
    const g = group({ id: 'isolate', resolve: () => ({ concurrency: 1 }) });
    const seen: string[] = [];
    const warnings: string[] = [];
    g.on('idle', () => {
      throw new Error('metrics bug');
    });
    g.on('idle', (_event, key) => seen.push(key));
    g.on('warning', (event, key) => warnings.push(`${key}:${event.message}`));
    g.on('warning', () => {
      throw new Error('warning bug');
    });
    await g.run('k', () => 1);
    await until(() => seen.length === 1);
    expect(warnings).toEqual(['k:Listener for idle threw: Error: metrics bug']);
  });

  it('forwards events from current and future valves with their key', async () => {
    const g = group({ id: 'events', resolve: () => ({ concurrency: 1 }) });
    await g.run('early', () => 1);
    const idle: string[] = [];
    const off = g.on('idle', (_event, key) => idle.push(key));
    const warnings: string[] = [];
    g.on('warning', (event, key) => warnings.push(`${key}:${event.message}`));
    g.on('reject', () => {
      throw new Error('listener bug');
    });
    await g.run('early', () => 1);
    await g.run('late', () => 1);
    await until(() => idle.length === 2);
    expect(idle).toEqual(['early', 'late']);
    off();
    await g.run('late', () => 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(idle).toHaveLength(2);
    const controller = new AbortController();
    controller.abort();
    await g.run('late', () => 1, { signal: controller.signal }).catch(() => {});
    expect(
      warnings.some((w) => w.startsWith('late:Listener for reject threw')),
    ).toBe(true);
  });
});

describe('createValveGroup managed limits', () => {
  const managed = (limit: number) => ({
    rate: { name: 'tenant', ...minute, limit },
    limits: 'managed' as const,
  });

  it('keeps stored limits authoritative over resolver seeds and across eviction', async () => {
    const store = memoryStore();
    const first = group({
      id: 'm',
      store,
      idleTtl: 0,
      resolve: () => managed(1),
    });
    await first.get('k').updateLimits({ tenant: { limit: 3 } });
    await until(() => first.stats().size === 0);
    // Another worker seeds a different limit; the stored limit wins.
    const second = group({ id: 'm', store, resolve: () => managed(10) });
    expect((await second.get('k').getLimits()).rules.tenant!.limit).toBe(3);
    expect((await first.get('k').getLimits()).rules.tenant!.limit).toBe(3);
    for (let i = 0; i < 3; i++) await second.run('k', () => i);
    expect(await spent(first, 'k')).toBe(true);
    // Other keys are seeded independently.
    expect((await second.get('other').getLimits()).rules.tenant!.limit).toBe(
      10,
    );
    await first.close();
    await second.close();
    await store.close();
  });

  it('rejects immutable rule mismatches for one key across workers', async () => {
    const store = memoryStore();
    const a = group({ id: 'imm', store, resolve: () => ({ rate: minute }) });
    const b = group({
      id: 'imm',
      store,
      resolve: () => ({ rate: { ...minute, limit: 2 } }),
    });
    await a.run('k', () => 1);
    await expect(b.run('k', () => 1)).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    });
    const managedWorker = group({
      id: 'imm',
      store,
      resolve: () => managed(1),
    });
    await expect(managedWorker.get('k').getLimits()).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    });
    await Promise.all([a.close(), b.close(), managedWorker.close()]);
    await store.close();
  });

  it('reports managed calls on immutable keys and invalid patches', async () => {
    const g = group({ id: 'mi', resolve: () => ({ rate: minute }) });
    await expect(g.get('k').getLimits()).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    });
    await expect(
      g.get('k').updateLimits({ x: { limit: 1 } }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(g.stats().active).toBe(0);
  });
});

describe('createValveGroup close', () => {
  it('rejects queued work without drain and waits for running work', async () => {
    const g = createValveGroup({
      id: 'close',
      resolve: () => ({ concurrency: 1 }),
    });
    const gate = deferred();
    let finished = false;
    const running = g.run('k', async () => {
      await gate.promise;
      finished = true;
    });
    const queued = g.run('k', () => 'never');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const closing = g.close();
    expect(g.close()).toBe(closing);
    await expect(queued).rejects.toMatchObject({ code: 'CLOSED' });
    gate.release();
    await closing;
    expect(finished).toBe(true);
    await running;
    expect(g.stats().size).toBe(0);
    await expect(g.run('k', () => 1)).rejects.toMatchObject({ code: 'CLOSED' });
    await expect(g.get('k').getLimits()).rejects.toMatchObject({
      code: 'CLOSED',
    });
  });

  it('drains queued work when asked', async () => {
    const g = createValveGroup({
      id: 'drain',
      resolve: () => ({ concurrency: 1 }),
    });
    const gate = deferred();
    const first = g.run('k', () => gate.promise);
    const queued = g.run('k', () => 'drained');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const closing = g.close({ drain: true });
    gate.release();
    await expect(queued).resolves.toBe('drained');
    await first;
    await closing;
  });

  it('waits for calls in progress before closing its own store', async () => {
    const store = memoryStore();
    const close = vi.spyOn(store, 'close');
    const managed = vi.spyOn(store.managed!, 'getLimits');
    const gate = deferred();
    managed.mockImplementationOnce(async (context) => {
      await gate.promise;
      return store.managed!.updateLimits({ ...context, patch: {} });
    });
    const owned = createValveGroup({
      id: 'owned',
      resolve: () => ({
        rate: { name: 'r', ...minute },
        limits: 'managed' as const,
      }),
    });
    const user = createValveGroup({
      id: 'user',
      store,
      resolve: () => ({
        rate: { name: 'r', ...minute },
        limits: 'managed' as const,
      }),
    });
    const limits = user.get('k').getLimits();
    await new Promise((resolve) => setTimeout(resolve, 5));
    let closed = false;
    const closing = user.close().then(() => (closed = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(false);
    gate.release();
    await limits;
    await closing;
    expect(close).not.toHaveBeenCalled();
    await owned.run('k', () => 1);
    await owned[Symbol.asyncDispose]();
    await expect(owned.run('k', () => 1)).rejects.toMatchObject({
      code: 'CLOSED',
    });
    await store.close();
  });

  it('rejects calls waiting for room once the group closes', async () => {
    const store = memoryStore();
    const release = store.release!.bind(store);
    const hold = deferred();
    store.release = async (...args) => {
      await hold.promise;
      return release(...args);
    };
    const g = createValveGroup({
      id: 'room',
      store,
      maxSize: 1,
      resolve: () => ({ concurrency: { limit: 1, scope: 'global' as const } }),
    });
    await g.run('a', () => 1);
    const waiting = g.run('b', () => 'b');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const closing = g.close();
    hold.release();
    await expect(waiting).rejects.toMatchObject({ code: 'CLOSED' });
    await closing;
    await store.close();
  });

  it('reports observe on a closed group as a warning', async () => {
    const g = createValveGroup({
      id: 'obs',
      resolve: () => ({ concurrency: 1 }),
    });
    const member = g.get('k');
    const warnings: string[] = [];
    g.on('warning', (event, key) => warnings.push(`${key}:${event.message}`));
    await g.close();
    member.observe({ status: 429, headers: {} });
    await until(() => warnings.length === 1);
    expect(warnings[0]).toMatch(/^k:observe failed: ValveError/);
    g.on('warning', () => {
      throw new Error('warning listener bug');
    });
    member.observe({ status: 200, headers: {} });
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

  it('does not close a user store and leaves no timers after close', async () => {
    const store: Store = memoryStore();
    const close = vi.spyOn(store, 'close');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const g = createValveGroup({
      id: 'timers',
      store,
      resolve: () => ({ concurrency: 1 }),
    });
    await g.run('k', () => 1);
    expect(vi.getTimerCount()).toBe(1);
    await g.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(close).not.toHaveBeenCalled();
    vi.useRealTimers();
    await store.close();
  });
});
