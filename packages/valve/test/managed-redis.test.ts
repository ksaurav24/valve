// Managed adapter trust boundaries, typed failures, snapshots, and one-call admission.
import { describe, expect, it, vi } from 'vitest';
import { createValve } from '../src/index.js';
import { normalize } from '../src/rules.js';
import { redisStore } from '../src/redis/index.js';

const rate = { name: 'throughput', limit: 10, interval: 1000, burst: 10 };
const context = {
  id: 'managed',
  rules: normalize({ id: 'managed', rate, limits: 'managed' }).rules,
};
const snapshot = ['1000000.2', '2', 'throughput', '20', '30'];
const adapterFor = (value: unknown) => ({
  evalsha: vi.fn().mockResolvedValue(value),
  eval: vi.fn(),
});

describe('managed Redis adapter', () => {
  it('serializes partial patches, scopes, leases and cluster keys; caches a stable structure', async () => {
    const adapter = adapterFor(snapshot);
    const store = redisStore({ adapter, prefix: 'p' });
    const first = await store.managed!.getLimits(context);
    expect(first).toEqual({
      version: '1000000.2',
      revision: 2,
      rules: {
        throughput: {
          algorithm: 'gcra',
          intervalMs: 1000,
          limit: 20,
          burst: 30,
        },
      },
    });
    expect(Object.isFrozen(first.rules.throughput)).toBe(true);
    await store.managed!.updateLimits({
      ...context,
      patch: { throughput: { limit: 20 } },
      expect: { throughput: { limit: 10 } },
    });
    await store.managed!.updateLimits({ ...context, patch: {} });
    await store.managed!.getLimits({
      ...context,
      lease: { limit: 2, ttlMs: 1000, owner: 'A' },
    });
    const [, keys, args] = adapter.evalsha.mock.calls[1]!;
    expect(keys).toEqual([
      'p:{managed}:config',
      'p:{managed}:limits',
      'p:{managed}:pause',
      'p:{managed}:leases',
      'p:{managed}:events',
      'p:{managed}:r:named:throughput',
    ]);
    expect(JSON.parse(args.at(-1))).toEqual({
      p: [['throughput', 20, false]],
      x: [['throughput', 10, false]],
    });
    await store.close();
  });

  it('admits stale numeric seeds with authoritative snapshots in a single call, then omits unchanged snapshots', async () => {
    const adapter = adapterFor([1, 50, 0, [], 0, 1, snapshot]);
    const store = redisStore({ adapter });
    const result = await store.managed!.acquire({
      ...context,
      costs: [1, 99],
      known: '1000000.1',
    });
    expect(result).toMatchObject({
      granted: 1,
      retryAfterMs: 50,
      impossible: true,
      limits: { version: '1000000.2' },
    });
    expect(adapter.evalsha).toHaveBeenCalledTimes(1);
    adapter.evalsha.mockResolvedValue([1, 0, 0, ['owner:0'], 1, 0, []]);
    expect(
      await store.managed!.acquire({
        ...context,
        costs: [1],
        lease: { limit: 1, ttlMs: 1000, owner: 'owner' },
        known: '1000000.2',
      }),
    ).toEqual({
      granted: 1,
      retryAfterMs: 0,
      pausedMs: 0,
      leases: ['owner:0'],
      leaseBlocked: true,
    });
    await store.close();
  });

  it('decodes scoped partitions, impossible jobs, pause and global lease tokens', async () => {
    const scopedContext = {
      id: 'managed',
      rules: normalize({
        id: 'managed',
        limits: 'managed',
        rate: { ...rate, scope: 'recipient' },
      }).rules,
    };
    const adapter = adapterFor([
      [0],
      [[1, 5, 1, 1]],
      [[0, 'owner:0']],
      7,
      snapshot,
    ]);
    const store = redisStore({ adapter });
    const result = await store.managed!.acquireScoped!({
      ...scopedContext,
      jobs: [
        { cost: 1, scopes: { recipient: 'A' } },
        { cost: 99, scopes: { recipient: 'B' } },
      ],
      lease: { limit: 1, ttlMs: 1000, owner: 'owner' },
    });
    expect(result).toMatchObject({
      grantedIndexes: [0],
      blocked: [
        { index: 1, retryAfterMs: 5, leaseBlocked: true, impossible: true },
      ],
      pausedMs: 7,
      leases: [{ index: 0, token: 'owner:0' }],
      limits: { rules: { throughput: { scope: 'recipient' } } },
    });
    adapter.evalsha.mockResolvedValue([[], [[0, 5, 0, 0]], [], 0, []]);
    expect(
      await store.managed!.acquireScoped!({
        ...scopedContext,
        jobs: [{ cost: 1, scopes: { recipient: 'A' } }],
      }),
    ).toEqual({ grantedIndexes: [], blocked: [{ index: 0, retryAfterMs: 5 }] });
    await store.close();
  });

  it.each([
    '!INVALID_OPTIONS:bad data',
    '!LIMITS_CONFLICT:conflicting patch',
    '!UNKNOWN:bad schema',
  ])('maps deterministic status %s to a typed error', async (raw) => {
    const store = redisStore({ adapter: adapterFor(raw) });
    await expect(store.managed!.getLimits(context)).rejects.toMatchObject({
      code: raw.includes('LIMITS_CONFLICT')
        ? 'LIMITS_CONFLICT'
        : 'INVALID_OPTIONS',
    });
    await store.close();
  });

  it.each([
    null,
    [],
    ['bad', '2', 'throughput', '20', '30'],
    ['1.2', '2', 'other', '20', '30'],
    ['1.2', '2', 'throughput', '0', '30'],
    ['1.2', '2', 'throughput', '20', '0'],
    ['1.2', '0', 'throughput', '20', '30'],
    ['1.3', '2', 'throughput', '20', '30'],
    ['999999999999999999999.2', '2', 'throughput', '20', '30'],
  ])('rejects malformed snapshots %j', async (raw) => {
    const store = redisStore({ adapter: adapterFor(raw) });
    await expect(store.managed!.getLimits(context)).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    });
    await store.close();
  });

  it.each([
    null,
    [1, -1, 0, [], 0, 0, []],
    [1, 0, 0, 'bad', 0, 0, []],
    [1, 0, 0, [], 0, 0, []],
    [1, 0, 0, [99], 0, 0, []],
    [2, 0, 0, ['a', 'b'], 0, 0, []],
    [1, 0, 0, ['a'], 2, 0, []],
  ])('rejects malformed leased static replies %j', async (raw) => {
    const store = redisStore({ adapter: adapterFor(raw) });
    await expect(
      store.managed!.acquire({
        ...context,
        costs: [1],
        lease: { limit: 1, ttlMs: 1000, owner: 'x' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    await store.close();
  });

  it.each([
    null,
    [[], [], [], -1, []],
    [[], 'bad', [], 0, []],
    [[0], [[0, 1, 0, 0]], [], 0, []],
    [[], [[1, 1, 0, 0]], [], 0, []],
    [[], [[0, 1, 2, 0]], [], 0, []],
    [[0], [], [[0, 'unexpected']], 0, []],
  ])('rejects malformed scoped replies %j', async (raw) => {
    const store = redisStore({ adapter: adapterFor(raw) });
    const rules = normalize({
      id: 'managed',
      rate: { ...rate, scope: 'recipient' },
      limits: 'managed',
    }).rules;
    await expect(
      store.managed!.acquireScoped!({
        id: 'managed',
        rules,
        jobs: [{ cost: 1, scopes: { recipient: 'A' } }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    await store.close();
  });

  it.each([
    'ERR user_script:12 bad value',
    'ERR Error running script: bad value',
  ])('fails closed under open policy on script error %s', async (message) => {
    const adapter = adapterFor(null);
    adapter.evalsha.mockRejectedValue(new Error(message));
    const store = redisStore({ adapter });
    const api = createValve({
      id: context.id,
      rate,
      limits: 'managed',
      store,
      onStoreError: 'open',
    });
    const fn = vi.fn();
    await expect(api.run(fn)).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    });
    expect(fn).not.toHaveBeenCalled();
    await api.close();
    await store.close();
  });

  it.each([
    'ERR OOM user_script:12',
    'READONLY user_script:12',
    'offline',
    'opaque',
  ])(
    'keeps infrastructure failures under store policy: %s',
    async (message) => {
      const adapter = adapterFor(null);
      const error = message === 'opaque' ? message : new Error(message);
      adapter.evalsha.mockRejectedValue(error);
      const store = redisStore({ adapter });
      await expect(store.managed!.getLimits(context)).rejects.toBe(error);
      await store.close();
    },
  );
});
