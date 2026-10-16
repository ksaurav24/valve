// Structural Redis adapters, NOSCRIPT recovery, TTL scripts, and call timeouts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { redisStore } from '../src/redis/index.js';
import type { RedisStoreOptions } from '../src/redis/index.js';
import { createValve } from '../src/index.js';
import { normalize } from '../src/rules.js';
const rules = normalize({ id: 'x', rate: { limit: 10, interval: '1s' } }).rules;
const request = { id: 'x', rules, costs: [1, 1] };
afterEach(() => vi.useRealTimers());
describe('redis store', () => {
  it.each([
    {},
    { client: {} },
    { client: { eval: vi.fn() } },
    { adapter: {} },
    { client: {}, adapter: {} },
  ])('rejects unsupported clients %j', (options) =>
    expect(() => redisStore(options as RedisStoreOptions)).toThrow(
      'valve: redisStore could not recognize the client. Pass an ioredis or node-redis v4+ client, or an adapter with evalsha and eval.',
    ),
  );
  it('validates prefix and timeout', () => {
    const adapter = { evalsha: vi.fn(), eval: vi.fn() };
    expect(() => redisStore({ adapter, prefix: '{bad}' })).toThrow();
    expect(() => redisStore({ adapter, timeout: -1 })).toThrow();
  });
  it('uses node-redis and keeps rules cached with string arguments', async () => {
    const client = {
      evalSha: vi.fn(async () => [2, 0, 0]),
      eval: vi.fn(async () => [2, 0, 0]),
    };
    const store = redisStore({ client, prefix: 'p' });
    expect(await store.acquire(request)).toEqual({
      granted: 2,
      retryAfterMs: 0,
      pausedMs: 0,
    });
    await store.acquire(request);
    expect(client.evalSha.mock.calls[0]).toEqual([
      expect.any(String),
      {
        keys: ['p:{x}:pause', 'p:{x}:r:gcra:1000', 'p:{x}:config'],
        arguments: [
          'v1:[["gcra",1000,10,1]]:local',
          '0',
          '1000',
          '10',
          '1',
          '2',
          '1',
          '1',
        ],
      },
    ]);
    await store.pause('x', 10);
    await store.resume('x');
    await store.close();
    expect(client.eval).not.toHaveBeenCalled();
  });
  it('uses ioredis, falls back to eval on NOSCRIPT, and goes back to evalsha', async () => {
    const evalsha = vi
      .fn()
      .mockRejectedValueOnce(new Error('ERR NOSCRIPT No matching script'))
      .mockResolvedValue([2, 0, 0]);
    const evalScript = vi.fn().mockResolvedValue([2, 0, 0]);
    const store = redisStore({ client: { evalsha, eval: evalScript } });
    await store.acquire(request);
    await store.acquire(request);
    expect(evalsha).toHaveBeenCalledTimes(2);
    expect(evalScript).toHaveBeenCalledTimes(1);
    expect(evalScript.mock.calls[0]?.slice(1)).toEqual([
      3,
      'valve:{x}:pause',
      'valve:{x}:r:gcra:1000',
      'valve:{x}:config',
      'v1:[["gcra",1000,10,1]]:local',
      '0',
      '1000',
      '10',
      '1',
      '2',
      '1',
      '1',
    ]);
  });
  it('uses fallback for node-redis without taking client ownership', async () => {
    const client = {
      evalSha: vi.fn().mockRejectedValue(new Error('NOSCRIPT')),
      eval: vi.fn().mockResolvedValue([2, 0, 0]),
    };
    const store = redisStore({ client });
    await store.acquire(request);
    expect(client.eval).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        keys: ['valve:{x}:pause', 'valve:{x}:r:gcra:1000', 'valve:{x}:config'],
      }),
    );
  });
  it.each(['wait', 'throw', 'open'] as const)(
    'rejects incompatible configuration without running jobs under %s',
    async (onStoreError) => {
      const adapter = {
        evalsha: vi.fn().mockResolvedValue('CONFIG_MISMATCH'),
        eval: vi.fn(),
      };
      const store = redisStore({ adapter });
      await expect(store.acquire(request)).rejects.toMatchObject({
        code: 'INVALID_OPTIONS',
        valveId: 'x',
        message: expect.stringContaining('shared quota configuration'),
      });
      const api = createValve({
        id: 'x',
        rate: { limit: 10, interval: '1s' },
        store,
        onStoreError,
        batch: 1,
      });
      const job = vi.fn();
      const reject = vi.fn();
      api.on('reject', reject);
      try {
        const results = await Promise.allSettled([api.run(job), api.run(job)]);
        for (const result of results)
          expect(result).toMatchObject({
            status: 'rejected',
            reason: {
              code: 'INVALID_OPTIONS',
              valveId: 'x',
              cause: { code: 'INVALID_OPTIONS' },
            },
          });
        expect(job).not.toHaveBeenCalled();
        expect(reject).toHaveBeenCalledTimes(2);
        expect(api.stats()).toMatchObject({
          queued: 0,
          totals: { started: 0, rejected: 2 },
        });
        expect(adapter.evalsha).toHaveBeenCalledTimes(3);
      } finally {
        await api.close();
        await store.close();
      }
    },
  );
  it('propagates unrelated and non-error failures and rejects invalid results', async () => {
    const adapter = {
      evalsha: vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockRejectedValueOnce('opaque')
        .mockResolvedValueOnce([1, -1, 0])
        .mockResolvedValueOnce(null),
      eval: vi.fn(),
    };
    const store = redisStore({ adapter });
    await expect(store.acquire(request)).rejects.toThrow('offline');
    await expect(store.acquire(request)).rejects.toBe('opaque');
    await expect(store.acquire(request)).rejects.toThrow('invalid acquire');
    await expect(store.acquire(request)).rejects.toThrow('invalid acquire');
    expect(adapter.eval).not.toHaveBeenCalled();
  });
  it('times out without leaking timers or accepting a late grant', async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    const store = redisStore({
      adapter: {
        evalsha: () =>
          new Promise((r) => {
            resolve = r;
          }),
        eval: vi.fn(),
      },
      timeout: 20,
    });
    const acquire = store.acquire(request);
    const check = expect(acquire).rejects.toThrow('timeout 20ms');
    await vi.advanceTimersByTimeAsync(21);
    await check;
    resolve([2, 0, 0]);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves open outage behavior when a timeout hides the mismatch response', async () => {
    vi.useFakeTimers();
    let respond!: (value: unknown) => void;
    const store = redisStore({
      adapter: {
        evalsha: () =>
          new Promise((resolve) => {
            respond = resolve;
          }),
        eval: vi.fn(),
      },
      timeout: 20,
    });
    const api = createValve({
      id: 'x',
      concurrency: 1,
      store,
      onStoreError: 'open',
    });
    const job = vi.fn(() => 42);
    try {
      const result = api.run(job);
      await vi.advanceTimersByTimeAsync(21);
      await expect(result).resolves.toBe(42);
      respond('CONFIG_MISMATCH');
      await vi.advanceTimersByTimeAsync(0);
      expect(job).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await api.close();
      await store.close();
    }
  });
});

describe('scoped Redis adapter', () => {
  const scopedRequest = {
    id: 'scoped',
    rules: normalize({
      id: 'scoped',
      rate: { name: 'r', scope: 'recipient', limit: 1, interval: 1000 },
    }).rules,
    jobs: [
      { cost: 1, scopes: { recipient: 'A' } },
      { cost: 1, scopes: { recipient: 'A' } },
    ],
  };
  it('deduplicates keys and decodes indexed grants and leases', async () => {
    const evalsha = vi
      .fn()
      .mockResolvedValueOnce([[0], [[1, 1000]], [[0, 'owner:0']], 0])
      .mockResolvedValue([[0], [[1, 1000]], [], 0]);
    const store = redisStore({ adapter: { evalsha, eval: vi.fn() } });
    expect(
      await store.acquireScoped!({
        ...scopedRequest,
        lease: { limit: 1, ttlMs: 100, owner: 'owner' },
      }),
    ).toEqual({
      grantedIndexes: [0],
      blocked: [{ index: 1, retryAfterMs: 1000 }],
      leases: [{ index: 0, token: 'owner:0' }],
    });
    expect(evalsha.mock.calls[0]![1]).toHaveLength(4);
    expect(await store.acquireScoped!(scopedRequest)).toEqual({
      grantedIndexes: [0],
      blocked: [{ index: 1, retryAfterMs: 1000 }],
    });
  });
  it('reports a shared pause on scoped replies', async () => {
    const evalsha = vi.fn().mockResolvedValue([[], [[0, 250]], [], 250]);
    const store = redisStore({ adapter: { evalsha, eval: vi.fn() } });
    expect(
      await store.acquireScoped!({
        ...scopedRequest,
        jobs: scopedRequest.jobs.slice(0, 1),
      }),
    ).toEqual({
      grantedIndexes: [],
      blocked: [{ index: 0, retryAfterMs: 250 }],
      pausedMs: 250,
    });
  });
  it.each([
    'CONFIG_MISMATCH',
    null,
    [0, 1, 2],
    [[0], [[1, 1000]], []],
    [[0], [[1, 1000]], [], -1],
  ])('rejects invalid scoped reply %j', async (raw) => {
    const store = redisStore({
      adapter: { evalsha: vi.fn().mockResolvedValue(raw), eval: vi.fn() },
    });
    await expect(store.acquireScoped!(scopedRequest)).rejects.toThrow();
  });
});
