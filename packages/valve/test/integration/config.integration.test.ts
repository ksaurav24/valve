// Atomic shared-quota compatibility, rolling-worker drift, and explicit resets.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Redis } from 'ioredis5';
import { createClient } from 'redis5';
import { createValve } from '../../src/index.js';
import { redisStore } from '../../src/redis/index.js';
import { normalize } from '../../src/rules.js';
import type { RateRule } from '../../src/types.js';

const url = process.env.REDIS_URL;
const suite = url ? describe : describe.skip;
suite('shared quota configuration', () => {
  const io = new Redis(url!, { lazyConnect: true });
  const node = createClient({ url: url! });
  const prefix = `config-test-${randomUUID()}`;
  const first = redisStore({ client: io, prefix });
  const second = redisStore({ client: node, prefix });
  const rule = {
    limit: 1,
    interval: 60000,
    algorithm: 'fixed-window',
  } as const;
  const request = (
    id: string,
    rate: RateRule | readonly RateRule[] = rule,
  ) => ({
    id,
    rules: normalize({ id, rate }).rules,
    costs: [1],
  });
  beforeAll(async () => {
    await io.connect();
    await node.connect();
  });
  afterAll(async () => {
    await first.close();
    await second.close();
    const keys = await io.keys(`${prefix}:*`);
    if (keys.length) await io.del(...keys);
    await io.quit();
    await node.quit();
  });

  it.each(['fixed-window', 'gcra'] as const)(
    'rejects the reported low/high limit reproduction for %s',
    async (algorithm) => {
      const id = `limits-${algorithm}`;
      const low = createValve({
        id,
        rate: { algorithm, limit: 1, interval: 60000 },
        store: first,
      });
      const high = createValve({
        id,
        rate: {
          algorithm,
          limit: 100,
          interval: 60000,
          ...(algorithm === 'gcra' ? { burst: 200 } : {}),
        },
        store: second,
        onStoreError: 'open',
      });
      const job = vi.fn();
      try {
        await low.run(() => 1);
        const key = `${prefix}:{${id}}:r:${algorithm}:60000`;
        const before = await io.dump(key);
        const results = await Promise.allSettled(
          Array.from({ length: 10 }, () => high.run(job)),
        );
        for (const result of results)
          expect(result).toMatchObject({
            status: 'rejected',
            reason: { code: 'INVALID_OPTIONS' },
          });
        expect(job).not.toHaveBeenCalled();
        expect(await io.dump(key)).toEqual(before);
      } finally {
        await low.close();
        await high.close();
      }
    },
  );

  it.each([
    { label: 'limit', rate: { ...rule, limit: 100 } },
    { label: 'interval', rate: { ...rule, interval: 120000 } },
    { label: 'algorithm', rate: { limit: 1, interval: 60000 } },
    { label: 'extra-rule', rate: [rule, { limit: 2, interval: 1000 }] },
  ])('rejects $label changes even while paused', async ({ label, rate }) => {
    const id = `paused-${label}`;
    await first.acquire(request(id));
    await first.pause(id, 60000);
    const fingerprint = await io.get(`${prefix}:{${id}}:config`);
    await expect(second.acquire(request(id, rate))).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    });
    expect(await io.get(`${prefix}:{${id}}:config`)).toBe(fingerprint);
    expect((await first.acquire(request(id))).pausedMs).toBeGreaterThan(0);
  });

  it('rejects burst changes and removed rules', async () => {
    const rate = [{ limit: 10, interval: 60000, burst: 1 }, rule];
    await first.acquire(request('burst', rate));
    await expect(
      second.acquire(request('burst', [{ ...rate[0]!, burst: 2 }, rule])),
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    await expect(second.acquire(request('burst', rule))).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    });
  });

  it('accepts equivalent normalization and rule ordering with different local settings', async () => {
    const id = 'equivalent';
    const low = createValve({
      id,
      rate: [
        { limit: 2, interval: 60000, burst: 2 },
        { ...rule, limit: 2 },
      ],
      concurrency: 1,
      batch: 1,
      store: first,
    });
    const peer = createValve({
      id,
      rate: [
        { ...rule, interval: '1m', limit: 2 },
        { algorithm: 'gcra', limit: 2, interval: '60s', burst: 2 },
      ],
      concurrency: 10,
      batch: 20,
      maxQueue: 3,
      maxWait: 2000,
      store: second,
    });
    try {
      await low.run(() => 1);
      await expect(peer.run(() => 2)).resolves.toBe(2);
      await expect(peer.run(() => 3, { maxWait: 30 })).rejects.toMatchObject({
        code: 'MAX_WAIT_EXCEEDED',
      });
    } finally {
      await low.close();
      await peer.close();
    }
  });

  it.each(['limit', 'ttl', 'scope'] as const)(
    'rejects global concurrency %s drift without creating another token',
    async (change) => {
      const id = `leases-${change}`;
      const original = {
        id,
        rules: [],
        costs: [1],
        lease: { limit: 1, ttlMs: 60000, owner: 'low' },
      };
      const grant = await first.acquire(original);
      expect(grant.leases).toEqual(['low:0']);
      const incompatible =
        change === 'scope'
          ? { id, rules: [], costs: [1] }
          : {
              ...original,
              lease: {
                limit: change === 'limit' ? 2 : 1,
                ttlMs: change === 'ttl' ? 120000 : 60000,
                owner: 'high',
              },
            };
      await expect(second.acquire(incompatible)).rejects.toMatchObject({
        code: 'INVALID_OPTIONS',
      });
      expect(await io.zrange(`${prefix}:{${id}}:leases`, 0, -1)).toEqual([
        'low:0',
      ]);
      expect(await first.renew!(id, grant.leases!, 60000)).toBe(true);
      await first.release!(id, grant.leases!);
      await expect(second.acquire(incompatible)).rejects.toMatchObject({
        code: 'INVALID_OPTIONS',
      });
    },
  );

  it('shares matching global settings across different owners and rejects enabling global scope', async () => {
    const original = {
      id: 'owners',
      rules: [],
      costs: [1],
      lease: { limit: 2, ttlMs: 60000, owner: 'first' },
    };
    expect((await first.acquire(original)).leases).toEqual(['first:0']);
    expect(
      (
        await second.acquire({
          ...original,
          lease: { ...original.lease, owner: 'second' },
        })
      ).leases,
    ).toEqual(['second:0']);
    expect((await first.acquire(original)).granted).toBe(0);
    await first.acquire({ id: 'local', rules: [], costs: [1] });
    await expect(
      second.acquire({ ...original, id: 'local' }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
  });

  it('atomically selects one configuration when incompatible workers first race', async () => {
    for (let i = 0; i < 20; i++) {
      const id = `race-${i}`;
      const results = await Promise.allSettled([
        first.acquire(request(id)),
        second.acquire(request(id, { ...rule, limit: 100 })),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.find((result) => result.status === 'rejected'),
      ).toMatchObject({ reason: { code: 'INVALID_OPTIONS' } });
      expect(await io.hget(`${prefix}:{${id}}:r:fixed-window:60000`, 'n')).toBe(
        '1',
      );
    }
  });

  it('pins idle configurations until an explicit reset and checks previously accepted workers again', async () => {
    const id = 'reset';
    const old = request(id, { limit: 1, interval: 30 });
    const next = request(id, { limit: 100, interval: 30 });
    await first.acquire(old);
    const configKey = `${prefix}:{${id}}:config`;
    await expect.poll(() => io.exists(`${prefix}:{${id}}:r:gcra:30`)).toBe(0);
    await first.close();
    expect(await io.pttl(configKey)).toBe(-1);
    await expect(second.acquire(next)).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    });
    await io.del(configKey); // Workers are idle and the previous rate debt expired.
    expect((await second.acquire(next)).granted).toBe(1);
    await expect(first.acquire(old)).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    });
  });

  it('preserves pre-fingerprint budget state on the first guarded admission', async () => {
    const id = 'legacy';
    const [seconds, micros] = await io.time();
    const window = Math.floor(
      (Number(seconds) * 1000 + Number(micros) / 1000) / 60000,
    );
    await io.hset(
      `${prefix}:{${id}}:r:fixed-window:60000`,
      'w',
      window,
      'n',
      1,
    );
    expect((await first.acquire(request(id))).granted).toBe(0);
    await expect(
      second.acquire(request(id, { ...rule, limit: 100 })),
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
  });

  it('lets the same rejected valve recover after a coordinated reset', async () => {
    const id = 'recover';
    await first.acquire(request(id, { limit: 1, interval: 30 }));
    const api = createValve({
      id,
      rate: { limit: 2, interval: 30 },
      store: second,
      onStoreError: 'wait',
      maxWait: 2000,
    });
    const job = vi.fn(() => 42);
    try {
      await expect(api.run(job)).rejects.toMatchObject({
        code: 'INVALID_OPTIONS',
      });
      expect(job).not.toHaveBeenCalled();
      await expect.poll(() => io.exists(`${prefix}:{${id}}:r:gcra:30`)).toBe(0);
      await io.del(`${prefix}:{${id}}:config`);
      await expect(api.run(job)).resolves.toBe(42);
      expect(job).toHaveBeenCalledTimes(1);
    } finally {
      await api.close();
    }
  });
});
