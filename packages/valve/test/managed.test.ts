import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createValve,
  memoryStore,
  type LimitsSnapshot,
  type ManagedAcquireRequest,
  type Store,
} from '../src/index.js';
import { normalize } from '../src/rules.js';

afterEach(() => vi.useRealTimers());

const managedRules = (
  rate: Parameters<typeof createValve>[0]['rate'] = {
    name: 'requests',
    limit: 10,
    interval: 1000,
    burst: 10,
  },
) => normalize({ id: 'normalize', rate, limits: 'managed' }).rules;

const staticRequest = (
  id: string,
  rules: ReturnType<typeof managedRules>,
  costs: readonly number[],
): ManagedAcquireRequest => ({ id, rules, costs });

const tick = () => vi.advanceTimersByTimeAsync(0);

describe('managed option and API validation', () => {
  it('rejects unknown modes, unnamed or absent rate rules, and unsupported stores at creation', () => {
    const base = memoryStore();
    const withoutManaged = {
      ...base,
      managed: undefined,
    } as unknown as Store;
    const wrongVersion = {
      ...base,
      managed: { ...base.managed!, version: 2 },
    } as unknown as Store;

    for (const options of [
      {
        id: 'unknown-mode',
        rate: { name: 'r', limit: 1, interval: 1000 },
        limits: 'dynamic',
      },
      {
        id: 'unnamed',
        rate: { limit: 1, interval: 1000 },
        limits: 'managed',
      },
      { id: 'no-rate', concurrency: 1, limits: 'managed' },
      {
        id: 'no-capability',
        rate: { name: 'r', limit: 1, interval: 1000 },
        limits: 'managed',
        store: withoutManaged,
      },
      {
        id: 'wrong-version',
        rate: { name: 'r', limit: 1, interval: 1000 },
        limits: 'managed',
        store: wrongVersion,
      },
    ])
      expect(() => createValve(options as never)).toThrowError(
        expect.objectContaining({ code: 'INVALID_OPTIONS' }),
      );
  });

  it('rejects managed APIs on an immutable valve', async () => {
    const valve = createValve({
      id: 'immutable-api',
      rate: { name: 'r', limit: 1, interval: 1000 },
    });
    await expect(valve.getLimits()).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    });
    await expect(valve.updateLimits({ r: { limit: 2 } })).rejects.toMatchObject(
      { code: 'INVALID_OPTIONS' },
    );
    await valve.close();
  });

  it.each([
    ['unknown rule', { absent: { limit: 2 } }, undefined],
    ['interval', { requests: { interval: 2 } }, undefined],
    ['algorithm', { requests: { algorithm: 'fixed-window' } }, undefined],
    ['scope', { requests: { scope: 'tenant' } }, undefined],
    ['zero limit', { requests: { limit: 0 } }, undefined],
    ['zero burst', { requests: { burst: 0 } }, undefined],
    ['negative limit', { requests: { limit: -1 } }, undefined],
    ['negative burst', { requests: { burst: -1 } }, undefined],
    ['fractional limit', { requests: { limit: 1.5 } }, undefined],
    ['fractional burst', { requests: { burst: 1.5 } }, undefined],
    ['NaN limit', { requests: { limit: Number.NaN } }, undefined],
    ['NaN burst', { requests: { burst: Number.NaN } }, undefined],
    [
      'unsafe limit',
      { requests: { limit: Number.MAX_SAFE_INTEGER + 1 } },
      undefined,
    ],
    [
      'unsafe burst',
      { requests: { burst: Number.MAX_SAFE_INTEGER + 1 } },
      undefined,
    ],
    ['non-object patch', null, undefined],
    ['non-object rule patch', { requests: 2 }, undefined],
    ['non-object options', { requests: { limit: 2 } }, 1],
    ['null options', { requests: { limit: 2 } }, null],
    ['array options', { requests: { limit: 2 } }, []],
    ['non-object expect', { requests: { limit: 2 } }, { expect: 1 }],
    [
      'bad expect',
      { requests: { limit: 2 } },
      { expect: { requests: { limit: 0 } } },
    ],
  ])('validates %s before calling the store', async (_name, patch, options) => {
    const store = memoryStore();
    const update = vi.spyOn(store.managed!, 'updateLimits');
    const valve = createValve({
      id: `validation-${_name}`,
      rate: { name: 'requests', limit: 10, interval: 1000, burst: 10 },
      limits: 'managed',
      store,
    });
    await expect(
      valve.updateLimits(patch as never, options as never),
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(update).not.toHaveBeenCalled();
    await valve.close();
    await store.close();
  });

  it('rejects burst changes on fixed-window rules before calling the store', async () => {
    const store = memoryStore();
    const update = vi.spyOn(store.managed!, 'updateLimits');
    const valve = createValve({
      id: 'fixed-burst',
      rate: {
        name: 'window',
        limit: 10,
        interval: 1000,
        algorithm: 'fixed-window',
      },
      limits: 'managed',
      store,
    });
    await expect(
      valve.updateLimits({ window: { burst: 2 } }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(update).not.toHaveBeenCalled();
    await valve.close();
    await store.close();
  });
});

describe('managed snapshots and atomic updates', () => {
  it('registers revision 1, freezes snapshots, updates to revision 2, and keeps a no-op version', async () => {
    let now = 10;
    const store = memoryStore({ clock: () => now });
    const notices: unknown[] = [];
    const unsubscribe = store.subscribe!('snapshots', (notice) =>
      notices.push(notice),
    ) as () => void;
    const valve = createValve({
      id: 'snapshots',
      rate: [
        {
          name: 'throughput',
          limit: 10,
          interval: '1s',
          burst: 4,
        },
        {
          name: 'tenant-window',
          scope: 'tenant',
          limit: 20,
          interval: '2s',
          algorithm: 'fixed-window',
        },
      ],
      limits: 'managed',
      store,
    });
    const events = vi.fn();
    valve.on('limits', events);

    const initial = await valve.getLimits();
    expect(initial).toEqual({
      version: '10000.1',
      revision: 1,
      rules: {
        throughput: {
          algorithm: 'gcra',
          intervalMs: 1000,
          limit: 10,
          burst: 4,
        },
        'tenant-window': {
          algorithm: 'fixed-window',
          intervalMs: 2000,
          limit: 20,
          burst: 1,
          scope: 'tenant',
        },
      },
    });
    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(initial.rules)).toBe(true);
    expect(Object.isFrozen(initial.rules.throughput)).toBe(true);

    now = 11;
    const updated = await valve.updateLimits({
      throughput: { limit: 12, burst: 6 },
    });
    expect(updated).toMatchObject({
      version: '10000.2',
      revision: 2,
      rules: { throughput: { limit: 12, burst: 6 } },
    });
    const noOp = await valve.updateLimits({
      throughput: { limit: 12, burst: 6 },
    });
    await Promise.resolve();
    expect(noOp).toEqual(updated);
    expect(events).toHaveBeenCalledTimes(2);
    expect(notices).toEqual([
      { type: 'limits', version: '10000.2', relaxed: true },
    ]);
    unsubscribe();
    await valve.close();
    await store.close();
  });

  it('composes concurrent updates to different rules and fields', async () => {
    const store = memoryStore();
    const rate = [
      { name: 'short', limit: 8, interval: 1000, burst: 8 },
      { name: 'long', limit: 64, interval: 8000, burst: 16 },
    ];
    const a = createValve({ id: 'compose', rate, limits: 'managed', store });
    const b = createValve({ id: 'compose', rate, limits: 'managed', store });
    await Promise.all([
      a.updateLimits({ short: { limit: 16 }, long: { burst: 32 } }),
      b.updateLimits({ short: { burst: 12 }, long: { limit: 128 } }),
    ]);
    expect(await a.getLimits()).toMatchObject({
      revision: 3,
      rules: {
        short: { limit: 16, burst: 12 },
        long: { limit: 128, burst: 32 },
      },
    });
    await Promise.all([a.close(), b.close()]);
    await store.close();
  });

  it('uses last-committed-wins for the same field', async () => {
    const store = memoryStore();
    const rate = { name: 'r', limit: 8, interval: 1000, burst: 8 };
    const a = createValve({ id: 'last-wins', rate, limits: 'managed', store });
    const b = createValve({ id: 'last-wins', rate, limits: 'managed', store });
    const [first, second] = await Promise.all([
      a.updateLimits({ r: { limit: 16 } }),
      b.updateLimits({ r: { limit: 32 } }),
    ]);
    expect(first.rules.r!.limit).toBe(16);
    expect(second.rules.r!.limit).toBe(32);
    expect((await a.getLimits()).rules.r!.limit).toBe(32);
    await Promise.all([a.close(), b.close()]);
    await store.close();
  });

  it('rejects an expect conflict without changing limits and accepts an idempotent retry', async () => {
    const store = memoryStore();
    const valve = createValve({
      id: 'expect',
      rate: { name: 'r', limit: 8, interval: 1000, burst: 8 },
      limits: 'managed',
      store,
    });
    const committed = await valve.updateLimits({ r: { limit: 16 } });
    await expect(
      valve.updateLimits({ r: { limit: 32 } }, { expect: { r: { limit: 8 } } }),
    ).rejects.toMatchObject({ code: 'LIMITS_CONFLICT' });
    expect(await valve.getLimits()).toEqual(committed);

    const retried = await valve.updateLimits(
      { r: { limit: 16 } },
      { expect: { r: { limit: 8 } } },
    );
    expect(retried).toEqual(committed);
    await valve.close();
    await store.close();
  });
});

describe('managed fixed-window state', () => {
  it('preserves a count when the limit is lowered', async () => {
    let now = 100;
    const store = memoryStore({ clock: () => now });
    const rules = managedRules({
      name: 'window',
      limit: 10,
      interval: 1000,
      algorithm: 'fixed-window',
    });
    expect(
      store.managed!.acquireSync!(staticRequest('fixed-down', rules, [5])),
    ).toMatchObject({ granted: 1, retryAfterMs: 0 });
    await store.managed!.updateLimits({
      id: 'fixed-down',
      rules,
      patch: { window: { limit: 3 } },
    });
    expect(
      store.managed!.acquireSync!(staticRequest('fixed-down', rules, [1])),
    ).toMatchObject({ granted: 0, retryAfterMs: 900 });
    now = 1000;
    expect(
      store.managed!.acquireSync!(staticRequest('fixed-down', rules, [3])),
    ).toMatchObject({ granted: 1, retryAfterMs: 0 });
    await store.close();
  });

  it('preserves a count when the limit is raised and admits only the added capacity', async () => {
    const now = 100;
    const store = memoryStore({ clock: () => now });
    const rules = managedRules({
      name: 'window',
      limit: 10,
      interval: 1000,
      algorithm: 'fixed-window',
    });
    expect(
      store.managed!.acquireSync!(staticRequest('fixed-up', rules, [10])),
    ).toMatchObject({ granted: 1 });
    await store.managed!.updateLimits({
      id: 'fixed-up',
      rules,
      patch: { window: { limit: 15 } },
    });
    expect(
      store.managed!.acquireSync!(staticRequest('fixed-up', rules, [5, 1])),
    ).toMatchObject({ granted: 1, retryAfterMs: 900 });
    await store.close();
  });
});

describe('managed GCRA state', () => {
  it('preserves cost-unit debt when the rate increases or decreases', async () => {
    for (const [id, nextLimit, retryAfterMs] of [
      ['rate-up', 20, 50],
      ['rate-down', 1, 1000],
    ] as const) {
      let now = 0;
      const store = memoryStore({ clock: () => now });
      const rules = managedRules({
        name: 'rate',
        limit: 10,
        interval: 1000,
        burst: 10,
      });
      expect(
        store.managed!.acquireSync!(staticRequest(id, rules, [10])).granted,
      ).toBe(1);
      await store.managed!.updateLimits({
        id,
        rules,
        patch: { rate: { limit: nextLimit } },
      });
      expect(
        store.managed!.acquireSync!(staticRequest(id, rules, [1])),
      ).toMatchObject({ granted: 0, retryAfterMs });
      now += retryAfterMs;
      expect(
        store.managed!.acquireSync!(staticRequest(id, rules, [1])).granted,
      ).toBe(1);
      await store.close();
    }
  });

  it('changes only the threshold when burst rises and falls', async () => {
    const store = memoryStore({ clock: () => 0 });
    const rules = managedRules({
      name: 'rate',
      limit: 10,
      interval: 1000,
      burst: 10,
    });
    expect(
      store.managed!.acquireSync!(staticRequest('burst', rules, [10])).granted,
    ).toBe(1);
    await store.managed!.updateLimits({
      id: 'burst',
      rules,
      patch: { rate: { burst: 20 } },
    });
    expect(
      store.managed!.acquireSync!(staticRequest('burst', rules, [10])).granted,
    ).toBe(1);
    await store.managed!.updateLimits({
      id: 'burst',
      rules,
      patch: { rate: { burst: 5 } },
    });
    expect(
      store.managed!.acquireSync!(staticRequest('burst', rules, [1])),
    ).toMatchObject({ granted: 0, retryAfterMs: 1600 });
    await store.close();
  });

  it('rebases debt correctly across several revisions skipped by an idle key', async () => {
    let now = 0;
    const store = memoryStore({ clock: () => now });
    const rules = managedRules({
      name: 'rate',
      limit: 8,
      interval: 1024,
      burst: 8,
    });
    expect(
      store.managed!.acquireSync!(staticRequest('skipped', rules, [8])).granted,
    ).toBe(1);
    now = 100;
    await store.managed!.updateLimits({
      id: 'skipped',
      rules,
      patch: { rate: { limit: 16 } },
    });
    now = 200;
    await store.managed!.updateLimits({
      id: 'skipped',
      rules,
      patch: { rate: { burst: 4 } },
    });
    now = 300;
    await store.managed!.updateLimits({
      id: 'skipped',
      rules,
      patch: { rate: { limit: 2 } },
    });
    expect(
      store.managed!.acquireSync!(staticRequest('skipped', rules, [1])),
    ).toMatchObject({ granted: 0, retryAfterMs: 560 });
    await store.close();
  });

  it('is bit-identical to immutable admission before the first update', () => {
    let now = 0;
    const managed = memoryStore({ clock: () => now });
    const immutable = memoryStore({ clock: () => now });
    const rules = managedRules({
      name: 'rate',
      limit: 8,
      interval: 1024,
      burst: 4,
    });
    for (const [at, costs] of [
      [0, [1, 2]],
      [17, [1, 3]],
      [128, [2, 1]],
      [511, [4]],
      [1024, [1, 1, 1]],
    ] as const) {
      now = at;
      const expected = immutable.acquireSync!({
        id: 'immutable-math',
        rules,
        costs,
      });
      const actual = managed.managed!.acquireSync!({
        id: 'managed-math',
        rules,
        costs,
      });
      expect(actual).toMatchObject(expected);
    }
  });
});

describe('scheduler reaction to managed limits', () => {
  it.each([
    ['static', undefined],
    ['scoped', 'account'],
  ] as const)(
    'starts a waiting %s job within 25ms of a shared raise',
    async (_kind, scope) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      vi.spyOn(Math, 'random').mockReturnValue(1);
      const store = memoryStore({ clock: () => Date.now() });
      const rate = {
        name: 'hour',
        ...(scope ? { scope } : {}),
        limit: 1,
        interval: '1h' as const,
        algorithm: 'fixed-window' as const,
      };
      const updating = createValve({
        id: `shared-raise-${_kind}`,
        rate,
        limits: 'managed',
        store,
      });
      const waiting = createValve({
        id: `shared-raise-${_kind}`,
        rate,
        limits: 'managed',
        store,
      });
      const runOptions = scope ? { scopes: { account: 'A' } } : undefined;
      await waiting.run(() => 'spent', runOptions);
      const fn = vi.fn(() => 'started');
      const job = waiting.run(fn, runOptions);
      await tick();
      expect(fn).not.toHaveBeenCalled();

      await updating.updateLimits({ hour: { limit: 2 } });
      await vi.advanceTimersByTimeAsync(24);
      expect(fn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(job).resolves.toBe('started');
      await Promise.all([updating.close(), waiting.close()]);
      await store.close();
    },
  );

  it('does not wake a waiting job early for a decrease', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = memoryStore({ clock: () => Date.now() });
    const rate = {
      name: 'hour',
      limit: 2,
      interval: '1h' as const,
      algorithm: 'fixed-window' as const,
    };
    const updating = createValve({
      id: 'shared-decrease',
      rate,
      limits: 'managed',
      store,
    });
    const waiting = createValve({
      id: 'shared-decrease',
      rate,
      limits: 'managed',
      store,
    });
    const acquire = vi.spyOn(store.managed!, 'acquireSync');
    await waiting.run(() => undefined, { cost: 2 });
    const job = waiting.run(() => 'too soon');
    await tick();
    const calls = acquire.mock.calls.length;
    await updating.updateLimits({ hour: { limit: 1 } });
    await vi.advanceTimersByTimeAsync(25);
    expect(acquire).toHaveBeenCalledTimes(calls);
    const rejection = expect(job).rejects.toMatchObject({ code: 'CLOSED' });
    await waiting.close({ drain: false });
    await rejection;
    await updating.close();
    await store.close();
  });

  it('an updating valve wakes its own queue immediately', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = memoryStore({ clock: () => Date.now() });
    const valve = createValve({
      id: 'self-raise',
      rate: {
        name: 'hour',
        limit: 1,
        interval: '1h',
        algorithm: 'fixed-window',
      },
      limits: 'managed',
      store,
    });
    await valve.run(() => undefined);
    const fn = vi.fn(() => 'started');
    const job = valve.run(fn);
    await tick();
    await valve.updateLimits({ hour: { limit: 2 } });
    await tick();
    await expect(job).resolves.toBe('started');
    await valve.close();
    await store.close();
  });

  it('reconciles a raise within one second without a subscriber', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const backing = memoryStore({ clock: () => Date.now() });
    const store = { ...backing };
    delete store.subscribe;
    const rate = {
      name: 'hour',
      limit: 1,
      interval: '1h' as const,
      algorithm: 'fixed-window' as const,
    };
    const a = createValve({
      id: 'reconcile',
      rate,
      limits: 'managed',
      store,
    });
    const b = createValve({
      id: 'reconcile',
      rate,
      limits: 'managed',
      store,
    });
    await b.run(() => undefined);
    const fn = vi.fn(() => 'started');
    const job = b.run(fn);
    await tick();
    await a.updateLimits({ hour: { limit: 2 } });
    await vi.advanceTimersByTimeAsync(999);
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(job).resolves.toBe('started');
    await Promise.all([a.close(), b.close()]);
    await backing.close();
  });

  it('emits limits once per newly observed version and warns for different configured seeds', async () => {
    const store = memoryStore();
    const first = createValve({
      id: 'limit-events',
      rate: { name: 'r', limit: 10, interval: 1000, burst: 10 },
      limits: 'managed',
      store,
    });
    const second = createValve({
      id: 'limit-events',
      rate: { name: 'r', limit: 99, interval: 1000, burst: 20 },
      limits: 'managed',
      store,
    });
    const events = vi.fn();
    const warning = vi.fn();
    second.on('limits', events);
    second.on('warning', warning);
    await first.getLimits();
    const initial = await second.getLimits();
    await second.getLimits();
    await second.run(() => undefined);
    await first.updateLimits({ r: { limit: 11 } });
    await second.run(() => undefined);
    expect(initial.rules.r).toMatchObject({ limit: 10, burst: 10 });
    expect(events.mock.calls.map(([snapshot]) => snapshot.revision)).toEqual([
      1, 2,
    ]);
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: expect.stringContaining('differ') }),
    );
    await Promise.all([first.close(), second.close()]);
    await store.close();
  });
});

describe('impossible managed costs', () => {
  it('rejects only the static head and lets a later job run', async () => {
    const store = memoryStore();
    const valve = createValve({
      id: 'impossible-static',
      rate: { name: 'r', limit: 3, interval: 1000, burst: 3 },
      limits: 'managed',
      store,
    });
    await valve.pause(1000);
    const head = valve.run(() => 'head', { cost: 3 });
    const later = valve.run(() => 'later');
    await valve.updateLimits({ r: { burst: 1 } });
    await valve.resume();
    await expect(head).rejects.toMatchObject({ code: 'COST_EXCEEDS_LIMIT' });
    await expect(later).resolves.toBe('later');
    await valve.close();
    await store.close();
  });

  it('rejects an impossible scoped job without affecting another identity', async () => {
    const store = memoryStore();
    const valve = createValve({
      id: 'impossible-scoped',
      rate: {
        name: 'r',
        scope: 'account',
        limit: 3,
        interval: 1000,
        burst: 3,
      },
      limits: 'managed',
      store,
    });
    await valve.pause(1000);
    const impossible = valve.run(() => 'A', {
      cost: 2,
      scopes: { account: 'A' },
    });
    const other = valve.run(() => 'B', { scopes: { account: 'B' } });
    await valve.updateLimits({ r: { burst: 1 } });
    await valve.resume();
    await expect(impossible).rejects.toMatchObject({
      code: 'COST_EXCEEDS_LIMIT',
    });
    await expect(other).resolves.toBe('B');
    await valve.close();
    await store.close();
  });

  it('gives COST_EXCEEDS_LIMIT precedence over maxWait 0', async () => {
    const valve = createValve({
      id: 'impossible-zero',
      rate: { name: 'r', limit: 1, interval: 1000, burst: 1 },
      limits: 'managed',
    });
    await expect(
      valve.run(() => undefined, { cost: 2, maxWait: 0 }),
    ).rejects.toMatchObject({ code: 'COST_EXCEEDS_LIMIT' });
    await valve.close();
  });

  it('accepts a cost above the configured seed when the store burst was raised', async () => {
    const store = memoryStore();
    const a = createValve({
      id: 'stale-submit',
      rate: { name: 'r', limit: 1, interval: 1000, burst: 1 },
      limits: 'managed',
      store,
    });
    const b = createValve({
      id: 'stale-submit',
      rate: { name: 'r', limit: 1, interval: 1000, burst: 1 },
      limits: 'managed',
      store,
    });
    await a.updateLimits({ r: { burst: 3 } });
    await expect(b.run(() => 'large', { cost: 3 })).resolves.toBe('large');
    await Promise.all([a.close(), b.close()]);
    await store.close();
  });
});

describe('managed and immutable coexistence', () => {
  it('allows an identical immutable valve until the first committed update', async () => {
    const store = memoryStore();
    const rate = { name: 'r', limit: 2, interval: 1000, burst: 2 };
    const immutable = createValve({ id: 'coexist', rate, store });
    const managed = createValve({
      id: 'coexist',
      rate,
      limits: 'managed',
      store,
    });
    await expect(immutable.run(() => 'immutable')).resolves.toBe('immutable');
    await expect(managed.run(() => 'managed')).resolves.toBe('managed');
    await managed.updateLimits({ r: { limit: 3 } });
    await expect(immutable.run(() => 'stale')).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    });
    await Promise.all([immutable.close(), managed.close()]);
    await store.close();
  });

  it('rejects an immutable valve with different numeric rules', async () => {
    const store = memoryStore();
    const managed = createValve({
      id: 'immutable-mismatch',
      rate: { name: 'r', limit: 2, interval: 1000, burst: 2 },
      limits: 'managed',
      store,
    });
    await managed.getLimits();
    const immutable = createValve({
      id: 'immutable-mismatch',
      rate: { name: 'r', limit: 3, interval: 1000, burst: 2 },
      store,
    });
    await expect(immutable.run(() => undefined)).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    });
    await Promise.all([immutable.close(), managed.close()]);
    await store.close();
  });

  it.each([
    [
      'interval',
      [{ name: 'r', limit: 2, interval: 2000, burst: 2 }],
      undefined,
    ],
    [
      'algorithm',
      [
        {
          name: 'r',
          limit: 2,
          interval: 1000,
          algorithm: 'fixed-window',
        },
      ],
      undefined,
    ],
    [
      'scope',
      [
        {
          name: 'r',
          scope: 'account',
          limit: 2,
          interval: 1000,
          burst: 2,
        },
      ],
      undefined,
    ],
    [
      'rule set',
      [
        { name: 'r', limit: 2, interval: 1000, burst: 2 },
        { name: 'extra', limit: 1, interval: 2000, burst: 1 },
      ],
      undefined,
    ],
    [
      'global concurrency',
      [{ name: 'r', limit: 2, interval: 1000, burst: 2 }],
      { limit: 3, scope: 'global' },
    ],
  ] as const)(
    'rejects a managed valve with a different %s',
    async (kind, conflictingRate, conflictingConcurrency) => {
      const store = memoryStore();
      const first = createValve({
        id: `managed-structure-${kind}`,
        rate: { name: 'r', limit: 2, interval: 1000, burst: 2 },
        ...(kind === 'global concurrency'
          ? { concurrency: { limit: 2, scope: 'global' as const } }
          : {}),
        limits: 'managed',
        store,
      });
      const conflicting = createValve({
        id: `managed-structure-${kind}`,
        rate: conflictingRate,
        ...(conflictingConcurrency
          ? { concurrency: conflictingConcurrency }
          : {}),
        limits: 'managed',
        store,
      } as never);
      await first.getLimits();
      await expect(conflicting.getLimits()).rejects.toMatchObject({
        code: 'INVALID_OPTIONS',
      });
      await Promise.all([first.close(), conflicting.close()]);
      await store.close();
    },
  );

  it('rejects static and scoped managed policies sharing an id', async () => {
    const store = memoryStore();
    const staticValve = createValve({
      id: 'static-scoped-managed',
      rate: { name: 'r', limit: 2, interval: 1000, burst: 2 },
      limits: 'managed',
      store,
    });
    const scopedValve = createValve({
      id: 'static-scoped-managed',
      rate: {
        name: 'r',
        scope: 'account',
        limit: 2,
        interval: 1000,
        burst: 2,
      },
      limits: 'managed',
      store,
    });
    await staticValve.getLimits();
    await expect(scopedValve.getLimits()).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    });
    await Promise.all([staticValve.close(), scopedValve.close()]);
    await store.close();
  });

  it('uses authoritative store values when a managed valve has different numeric seeds', async () => {
    const store = memoryStore();
    const first = createValve({
      id: 'numeric-seeds',
      rate: { name: 'r', limit: 2, interval: 1000, burst: 2 },
      limits: 'managed',
      store,
    });
    await first.getLimits();
    const second = createValve({
      id: 'numeric-seeds',
      rate: { name: 'r', limit: 200, interval: 1000, burst: 20 },
      limits: 'managed',
      store,
    });
    expect((await second.getLimits()).rules.r).toMatchObject({
      limit: 2,
      burst: 2,
    });
    await Promise.all([first.close(), second.close()]);
    await store.close();
  });
});

describe('managed failure and lifecycle policy', () => {
  it('fails closed on a structural mismatch even with onStoreError open', async () => {
    const store = memoryStore();
    const registered = createValve({
      id: 'fail-open-structure',
      rate: { name: 'r', limit: 1, interval: 1000 },
      limits: 'managed',
      store,
    });
    await registered.getLimits();
    const conflicting = createValve({
      id: 'fail-open-structure',
      rate: { name: 'r', limit: 1, interval: 2000 },
      limits: 'managed',
      onStoreError: 'open',
      store,
    });
    const callback = vi.fn();
    await expect(conflicting.run(callback)).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    });
    expect(callback).not.toHaveBeenCalled();
    await Promise.all([registered.close(), conflicting.close()]);
    await store.close();
  });

  it('keeps admission paused when limits are raised during a pause', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = memoryStore({ clock: () => Date.now() });
    const valve = createValve({
      id: 'managed-pause',
      rate: { name: 'r', limit: 1, interval: 1000, burst: 1 },
      limits: 'managed',
      store,
    });
    await valve.pause(1000);
    const fn = vi.fn(() => 'started');
    const job = valve.run(fn);
    await valve.updateLimits({ r: { limit: 2, burst: 2 } });
    await vi.advanceTimersByTimeAsync(999);
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(job).resolves.toBe('started');
    await valve.close();
    await store.close();
  });

  it('still aborts and closes jobs waiting after an update', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = memoryStore({ clock: () => Date.now() });
    const rate = {
      name: 'window',
      limit: 2,
      interval: '1h' as const,
      algorithm: 'fixed-window' as const,
    };
    const aborting = createValve({
      id: 'managed-abort',
      rate,
      limits: 'managed',
      store,
    });
    await aborting.run(() => undefined, { cost: 2 });
    await aborting.updateLimits({ window: { limit: 1 } });
    const controller = new AbortController();
    const aborted = aborting.run(() => undefined, {
      signal: controller.signal,
    });
    await tick();
    const abortCheck = expect(aborted).rejects.toMatchObject({
      code: 'ABORTED',
    });
    controller.abort('stop');
    await abortCheck;

    const closing = createValve({
      id: 'managed-close',
      rate,
      limits: 'managed',
      store,
    });
    await closing.run(() => undefined, { cost: 2 });
    await closing.updateLimits({ window: { limit: 1 } });
    const closed = closing.run(() => undefined);
    await tick();
    const closeCheck = expect(closed).rejects.toMatchObject({ code: 'CLOSED' });
    await closing.close({ drain: false });
    await closeCheck;
    await aborting.close();
    await store.close();
  });

  it('uses global leases and does not classify a lease-blocked head as impossible', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = memoryStore({ clock: () => Date.now() });
    const valve = createValve({
      id: 'managed-global',
      rate: { name: 'r', limit: 1, interval: 1000, burst: 1 },
      concurrency: { limit: 1, scope: 'global', leaseTtl: 300 },
      limits: 'managed',
      store,
    });
    let release!: () => void;
    const first = valve.run(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await tick();
    const second = valve.run(() => 'impossible', { cost: 2 });
    await vi.advanceTimersByTimeAsync(50);
    expect(valve.stats()).toMatchObject({ queued: 1, running: 1 });
    release();
    await first;
    await expect(second).rejects.toMatchObject({
      code: 'COST_EXCEEDS_LIMIT',
    });
    await valve.close();
    await store.close();
  });
});

describe('managed snapshot cache ordering', () => {
  it('ignores an older late reply but accepts an older version from a later call with a warning', async () => {
    const backing = memoryStore();
    const replies: ((snapshot: LimitsSnapshot) => void)[] = [];
    const getLimits = vi.fn(
      () =>
        new Promise<LimitsSnapshot>((resolve) => {
          replies.push(resolve);
        }),
    );
    const store: Store = {
      ...backing,
      managed: { ...backing.managed!, getLimits },
    };
    const valve = createValve({
      id: 'cache-order',
      rate: { name: 'r', limit: 1, interval: 1000, burst: 1 },
      limits: 'managed',
      store,
    });
    const versions: string[] = [];
    const warning = vi.fn();
    valve.on('limits', ({ version }) => versions.push(version));
    valve.on('warning', warning);
    const snapshot = (version: string, revision: number, limit: number) =>
      Object.freeze({
        version,
        revision,
        rules: Object.freeze({
          r: Object.freeze({
            algorithm: 'gcra' as const,
            intervalMs: 1000,
            limit,
            burst: 1,
          }),
        }),
      });

    const earlier = valve.getLimits();
    const later = valve.getLimits();
    await Promise.resolve();
    replies[1]!(snapshot('10.2', 2, 1));
    await later;
    replies[0]!(snapshot('10.1', 1, 1));
    await earlier;
    expect(versions).toEqual(['10.2']);

    const failover = valve.getLimits();
    await Promise.resolve();
    replies[2]!(snapshot('10.1', 1, 1));
    await failover;
    expect(versions).toEqual(['10.2', '10.1']);
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: expect.stringContaining('older') }),
    );
    await valve.close();
    await backing.close();
  });
});
