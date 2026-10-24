// Independent groups on Redis/Valkey: shared ids per key, store state that outlives eviction.
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis5';
import { createValveGroup } from '../../src/group/index.js';
import type { ValveGroup, ValveGroupOptions } from '../../src/group/index.js';
import { redisStore } from '../../src/redis/index.js';

const url = process.env.REDIS_URL;
const suite = url ? describe : describe.skip;
const minute = { limit: 1, interval: '1m', algorithm: 'fixed-window' } as const;
const managed = (limit: number) => ({
  rate: { name: 'key', ...minute, limit },
  limits: 'managed' as const,
});
const until = async (ready: () => boolean) => {
  for (let i = 0; i < 300 && !ready(); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(ready()).toBe(true);
};
suite('createValveGroup on Redis/Valkey', () => {
  const prefix = `group-${randomUUID()}`;
  const clientA = new Redis(url!, { lazyConnect: true });
  const clientB = new Redis(url!, { lazyConnect: true });
  const subscriberB = new Redis(url!, { lazyConnect: true });
  const storeA = redisStore({ client: clientA, prefix });
  const storeB = redisStore({
    client: clientB,
    subscriber: subscriberB,
    prefix,
  });
  const opened: ValveGroup[] = [];
  const group = (options: ValveGroupOptions) => {
    const created = createValveGroup(options);
    opened.push(created);
    return created;
  };
  const spent = (g: ValveGroup, key: string) =>
    g
      .run(key, () => false, { maxWait: 0 })
      .catch((error: { code?: string }) => error.code === 'MAX_WAIT_EXCEEDED');
  beforeAll(() =>
    Promise.all([clientA.connect(), clientB.connect(), subscriberB.connect()]),
  );
  afterAll(async () => {
    await Promise.all(opened.map((g) => g.close()));
    const keys = await clientA.keys(`${prefix}:*`);
    if (keys.length) await clientA.del(...keys);
    await Promise.all([storeA.close(), storeB.close()]);
    clientA.disconnect();
    clientB.disconnect();
    subscriberB.disconnect();
  });

  it('shares one budget per key across workers and processes, never across keys', async () => {
    const id = `tenants-${randomUUID()}`;
    const a = group({ id, store: storeA, resolve: () => managed(1) });
    const b = group({ id, store: storeB, resolve: () => managed(1) });
    await a.run('t1', () => 1);
    expect(await spent(b, 't1')).toBe(true);
    expect(await spent(b, 't2')).toBe(false);
    const child = fork(
      fileURLToPath(new URL('./group-worker.mjs', import.meta.url)),
      [url!, prefix, id, 't1', 't2', 't3', 'a:b'],
    );
    const { granted } = await new Promise<{
      granted: Record<string, unknown>;
    }>((resolve, reject) => {
      child.once('message', resolve as never);
      child.once('error', reject);
    });
    await new Promise((resolve) => child.once('exit', resolve));
    expect(granted).toEqual({
      t1: 'MAX_WAIT_EXCEEDED',
      t2: 'MAX_WAIT_EXCEEDED',
      t3: true,
      'a:b': true,
    });
    expect(await spent(a, 't3')).toBe(true);
    expect(await spent(a, 'a:b')).toBe(true);
    // Only Redis keys hash-tagged with a derived child id exist.
    const keys = await clientA.keys(`${prefix}:{${id}:*`);
    const tags = new Set(keys.map((key) => /\{(.*)\}/.exec(key)![1]));
    expect([...tags].sort()).toEqual(
      ['t1', 't2', 't3', 'a%3Ab'].map((key) => `${id}:${key}`).sort(),
    );
  });

  it('keeps managed updates and spent budget across eviction and stale seeds', async () => {
    const id = `managed-${randomUUID()}`;
    const a = group({
      id,
      store: storeA,
      idleTtl: 0,
      resolve: () => managed(1),
    });
    await a.get('k').updateLimits({ key: { limit: 2 } });
    await a.run('k', () => 1);
    const before = await clientA.keys(`${prefix}:{${id}:k}*`);
    await until(() => a.stats().size === 0);
    // Eviction frees memory only; Redis keeps every key.
    expect((await clientA.keys(`${prefix}:{${id}:k}*`)).sort()).toEqual(
      before.sort(),
    );
    const b = group({ id, store: storeB, resolve: () => managed(50) });
    const limits: number[] = [];
    b.on('limits', (snapshot) => limits.push(snapshot.rules.key!.limit));
    expect((await b.get('k').getLimits()).rules.key!.limit).toBe(2);
    await b.run('k', () => 2);
    expect(await spent(a, 'k')).toBe(true);
    await a.get('k').updateLimits({ key: { limit: 5 } });
    // The next admission uses the stored limit, and reports it once.
    await expect(b.run('k', () => 3, { maxWait: 0 })).resolves.toBe(3);
    expect(limits).toContain(5);
  });

  it('rejects mismatched immutable rules for one key across workers', async () => {
    const id = `immutable-${randomUUID()}`;
    const a = group({ id, store: storeA, resolve: () => ({ rate: minute }) });
    const b = group({
      id,
      store: storeB,
      resolve: () => ({ rate: { ...minute, limit: 2 } }),
    });
    await a.run('k', () => 1);
    await expect(b.run('k', () => 1)).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    });
    await expect(b.run('other', () => 'other')).resolves.toBe('other');
  });

  it('keeps 429 cooldowns per key and shares them for the same key', async () => {
    const id = `cooldown-${randomUUID()}`;
    const a = group({ id, store: storeA, resolve: () => ({ concurrency: 2 }) });
    const b = group({ id, store: storeB, resolve: () => ({ concurrency: 2 }) });
    const paused: string[] = [];
    b.on('pause', (_event, key) => paused.push(key));
    await b.run('slow', () => 1);
    a.get('slow').observe({ status: 429, headers: { 'retry-after': '60' } });
    await until(() => paused.includes('slow'));
    await expect(b.run('slow', () => 1, { maxWait: 50 })).rejects.toMatchObject(
      { code: 'MAX_WAIT_EXCEEDED' },
    );
    await expect(b.run('fast', () => 'fast', { maxWait: 50 })).resolves.toBe(
      'fast',
    );
    await a.get('slow').resume();
    await expect(b.run('slow', () => 'resumed')).resolves.toBe('resumed');
  });

  it('shares the caller connection for many keys and never closes it', async () => {
    const id = `connections-${randomUUID()}`;
    const count = async () =>
      String(await clientA.client('LIST'))
        .trim()
        .split('\n').length;
    const before = await count();
    const g = createValveGroup({
      id,
      store: storeA,
      maxSize: 20,
      idleTtl: 0,
      resolve: () => ({
        rate: { limit: 100, interval: '1s' },
        concurrency: { limit: 2, scope: 'global' },
      }),
    });
    await Promise.all(
      Array.from({ length: 200 }, (_, i) => g.run(`k${i % 60}`, () => i)),
    ).catch(() => {});
    expect(g.stats().size).toBeLessThanOrEqual(20);
    expect(await count()).toBe(before);
    await g.close({ drain: true });
    expect(clientA.status).toBe('ready');
    expect(await clientA.ping()).toBe('PONG');
  });

  it('rejects with STORE_UNAVAILABLE during an outage and releases the key', async () => {
    const down = new Redis({
      port: 1,
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
    });
    const store = redisStore({ client: down, prefix, timeout: 200 });
    const g = createValveGroup({
      id: `outage-${randomUUID()}`,
      store,
      resolve: () => ({ rate: minute, onStoreError: 'throw' as const }),
    });
    await expect(g.run('k', () => 1)).rejects.toMatchObject({
      code: 'STORE_UNAVAILABLE',
    });
    expect(g.stats()).toEqual({ size: 1, active: 0 });
    await g.close();
    await store.close();
    down.disconnect();
  });
});
