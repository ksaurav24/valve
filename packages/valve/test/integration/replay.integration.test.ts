// Hold real clients offline until Valve's timeout, then inspect replayed Lua effects.
import { once } from 'node:events';
import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { Redis } from 'ioredis5';
import { createClient as createV4 } from 'redis4';
import { createClient as createV5 } from 'redis5';
import { createValve } from '../../src/index.js';
import { redisStore } from '../../src/redis/index.js';
import { normalize } from '../../src/rules.js';
import {
  ACQUIRE,
  PAUSE,
  RESUME,
  RENEW,
  RELEASE,
} from '../../src/redis/scripts.js';

const url = process.env.REDIS_URL;
const suite = url ? describe : describe.skip;
const kinds = ['ioredis', 'node-redis-v4', 'node-redis-v5'] as const;
type Kind = (typeof kinds)[number];

// A healthy observer bypasses the proxy. Closing every socket while blocked
// makes reconnect timing irrelevant: no command reaches Redis before restore().
async function fixture(kind: Kind = 'ioredis', offlineQueue = true) {
  const target = new URL(url!);
  const upstreamAddress = {
    host: target.hostname,
    port: Number(target.port || 6379),
  };
  const observer = new Redis(url!, { lazyConnect: true });
  const sockets = new Set<Socket>();
  let blocked = false;
  const proxy = createServer((incoming) => {
    if (blocked) {
      incoming.destroy();
      return;
    }
    const upstream = createConnection(upstreamAddress);
    for (const socket of [incoming, upstream]) {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => {
        sockets.delete(socket);
        incoming.destroy();
        upstream.destroy();
      });
    }
    incoming.pipe(upstream).pipe(incoming);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const address = proxy.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing proxy port');
  target.hostname = '127.0.0.1';
  target.port = String(address.port);
  const nodeOptions = {
    url: target.toString(),
    disableOfflineQueue: !offlineQueue,
    socket: { reconnectStrategy: () => 20 },
  };
  const client =
    kind === 'ioredis'
      ? new Redis(target.toString(), {
          lazyConnect: true,
          enableOfflineQueue: offlineQueue,
          maxRetriesPerRequest: null,
          retryStrategy: () => 20,
        })
      : kind === 'node-redis-v4'
        ? createV4(nodeOptions)
        : createV5(nodeOptions);
  client.on('error', () => undefined);
  const ready = () =>
    kind === 'ioredis'
      ? (client as Redis).status === 'ready'
      : (client as ReturnType<typeof createV5>).isReady;
  const prefix = `replay-${process.pid}-${address.port}`;
  const store = redisStore({ client, prefix, timeout: 40 });
  try {
    await observer.connect();
    for (const script of [ACQUIRE, PAUSE, RESUME, RENEW, RELEASE])
      await observer.script('LOAD', script);
    await client.connect();
  } catch (error) {
    await close();
    throw error;
  }
  async function close() {
    await store.close();
    if (kind === 'ioredis') (client as Redis).disconnect();
    else if (kind === 'node-redis-v4')
      await (client as ReturnType<typeof createV4>).disconnect();
    else (client as ReturnType<typeof createV5>).destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    const keys = await observer.keys(`${prefix}:*`);
    if (keys.length) await observer.del(...keys);
    observer.disconnect();
  }
  return {
    observer,
    store,
    prefix,
    close,
    async interrupt() {
      blocked = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await expect.poll(ready).toBe(false);
    },
    async restore() {
      blocked = false;
      proxy.listen(address.port, '127.0.0.1');
      await once(proxy, 'listening');
      await expect.poll(ready).toBe(true);
      // PING is queued after the mutations and is a replay-completion barrier.
      await client.ping();
    },
  };
}

const rules = normalize({
  id: 'quota',
  rate: { limit: 1, interval: 3_600_000, algorithm: 'fixed-window' },
}).rules;
const request = (id: string) => ({ id, rules, costs: [1] });
const timeout = (operation: Promise<unknown>) =>
  expect(operation).rejects.toThrow('redis store call exceeded timeout 40ms');

suite('post-timeout offline replay', () => {
  it.each(kinds)('replays an abandoned acquire with %s', async (kind) => {
    const f = await fixture(kind);
    const key = `${f.prefix}:{quota}:r:${rules[0]!.key}`;
    try {
      await f.interrupt();
      await timeout(f.store.acquire(request('quota')));
      expect(await f.observer.exists(key)).toBe(0);
      const [seconds, micros] = await f.observer.time();
      const before = Number(seconds) * 1000 + Number(micros) / 1000;
      await f.restore();
      expect(await f.observer.hget(key, 'n')).toBe('1');
      expect(Number(await f.observer.hget(key, 'w'))).toBeGreaterThanOrEqual(
        Math.floor(before / 3_600_000),
      );
      expect((await f.store.acquire(request('quota'))).granted).toBe(0);
    } finally {
      await f.close();
    }
  });

  it.each(kinds)(
    'rejects offline acquires without replay with %s',
    async (kind) => {
      const f = await fixture(kind, false);
      const key = `${f.prefix}:{quota}:r:${rules[0]!.key}`;
      try {
        await f.interrupt();
        await expect(f.store.acquire(request('quota'))).rejects.toThrow(
          /offline|writeable/i,
        );
        expect(await f.observer.exists(key)).toBe(0);
        await f.restore();
        expect(await f.observer.exists(key)).toBe(0);
        expect((await f.store.acquire(request('quota'))).granted).toBe(1);
      } finally {
        await f.close();
      }
    },
  );

  it('creates an abandoned lease at replay time and expires it without release', async () => {
    const f = await fixture();
    const key = `${f.prefix}:{quota}:leases`;
    try {
      await f.interrupt();
      await timeout(
        f.store.acquire({
          ...request('quota'),
          lease: { limit: 1, ttlMs: 1000, owner: 'abandoned' },
        }),
      );
      expect(await f.observer.exists(key)).toBe(0);
      const [seconds, micros] = await f.observer.time();
      const before = Number(seconds) * 1000 + Number(micros) / 1000;
      await f.restore();
      expect(
        Number(await f.observer.zscore(key, 'abandoned:0')),
      ).toBeGreaterThanOrEqual(before + 1000);
      expect(
        (
          await f.store.acquire({
            id: 'quota',
            rules: [],
            costs: [1],
            lease: { limit: 1, ttlMs: 1000, owner: 'next' },
          })
        ).granted,
      ).toBe(0);
      await expect
        .poll(() => f.observer.exists(key), { timeout: 3000 })
        .toBe(0);
      expect(
        await f.observer.hget(`${f.prefix}:{quota}:r:${rules[0]!.key}`, 'n'),
      ).toBe('1');
    } finally {
      await f.close();
    }
  });

  it('applies late pause and resume, preserving FIFO on one client', async () => {
    const f = await fixture();
    const key = `${f.prefix}:{control}:pause`;
    try {
      await f.interrupt();
      await timeout(f.store.pause('control', 5000));
      expect(await f.observer.exists(key)).toBe(0);
      await f.restore();
      expect(await f.observer.pttl(key)).toBeGreaterThan(3000);
      await f.interrupt();
      await timeout(f.store.resume('control'));
      expect(await f.observer.exists(key)).toBe(1);
      await f.restore();
      expect(await f.observer.exists(key)).toBe(0);
      await f.interrupt();
      await timeout(f.store.pause('control', 5000));
      await timeout(f.store.resume('control'));
      await f.restore();
      expect(await f.observer.exists(key)).toBe(0);
    } finally {
      await f.close();
    }
  });

  it.each(['renew', 'release'] as const)(
    'applies a late %s to a still-owned lease',
    async (operation) => {
      const f = await fixture();
      const key = `${f.prefix}:{active}:leases`;
      try {
        const result = await f.store.acquire({
          id: 'active',
          rules: [],
          costs: [1],
          lease: { limit: 1, ttlMs: 5000, owner: 'active' },
        });
        const score = await f.observer.zscore(key, 'active:0');
        await f.interrupt();
        await timeout(
          operation === 'renew'
            ? f.store.renew!('active', result.leases!, 10000)
            : f.store.release!('active', result.leases!),
        );
        expect(await f.observer.zscore(key, 'active:0')).toBe(score);
        await f.restore();
        if (operation === 'renew')
          expect(
            Number(await f.observer.zscore(key, 'active:0')),
          ).toBeGreaterThan(Number(score));
        else expect(await f.observer.zscore(key, 'active:0')).toBeNull();
      } finally {
        await f.close();
      }
    },
  );

  it.each(['renew', 'release'] as const)(
    'late %s cannot resurrect expired ownership or remove its replacement',
    async (operation) => {
      const f = await fixture();
      const key = `${f.prefix}:{lease}:leases`;
      const acquire = (owner: string, ttlMs: number) =>
        f.store.acquire({
          id: 'lease',
          rules: [],
          costs: [1],
          lease: { limit: 1, ttlMs, owner },
        });
      try {
        const old = await acquire('old', 200);
        await f.interrupt();
        await timeout(
          operation === 'renew'
            ? f.store.renew!('lease', old.leases!, 5000)
            : f.store.release!('lease', old.leases!),
        );
        await expect.poll(() => f.observer.exists(key)).toBe(0);
        const healthy = redisStore({ client: f.observer, prefix: f.prefix });
        const replacement = await healthy.acquire({
          id: 'lease',
          rules: [],
          costs: [1],
          lease: { limit: 1, ttlMs: 5000, owner: 'new' },
        });
        const score = await f.observer.zscore(key, replacement.leases![0]!);
        await f.restore();
        expect(await f.observer.zrange(key, 0, -1)).toEqual(['new:0']);
        expect(await f.observer.zscore(key, 'new:0')).toBe(score);
        expect(await f.observer.zscore(key, 'old:0')).toBeNull();
        await healthy.close();
      } finally {
        await f.close();
      }
    },
  );

  it.each(['wait', 'throw', 'open'] as const)(
    'handles late responses under %s without double execution',
    async (policy) => {
      const f = await fixture();
      let calls = 0;
      const api = createValve({
        id: 'policy',
        rate: { limit: 1, interval: 3_600_000, algorithm: 'fixed-window' },
        store: f.store,
        onStoreError: policy,
        maxWait: 600,
      });
      try {
        await f.interrupt();
        const task = api.run(() => ++calls);
        const result =
          policy === 'open'
            ? expect(task).resolves.toBe(1)
            : expect(task).rejects.toMatchObject({
                code:
                  policy === 'throw'
                    ? 'STORE_UNAVAILABLE'
                    : 'MAX_WAIT_EXCEEDED',
              });
        await expect
          .poll(() => api.stats().totals.storeErrors)
          .toBeGreaterThan(0);
        await f.restore();
        await result;
        expect(calls).toBe(policy === 'open' ? 1 : 0);
        expect(
          await f.observer.hget(`${f.prefix}:{policy}:r:${rules[0]!.key}`, 'n'),
        ).toBe('1');
        expect(
          (
            await f.store.acquire({
              id: 'policy',
              rules: normalize({
                id: 'policy',
                rate: {
                  limit: 1,
                  interval: 3_600_000,
                  algorithm: 'fixed-window',
                },
              }).rules,
              costs: [1],
            })
          ).granted,
        ).toBe(0);
      } finally {
        await api.close();
        await f.close();
      }
    },
  );
});
