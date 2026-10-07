// Real global slot bounds, renewable TTLs, pub/sub wakeups, and killed workers.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Redis } from 'ioredis5';
import { createClient as createV4 } from 'redis4';
import { createClient as createV5 } from 'redis5';
import { createValve } from '../../src/index.js';
import { redisStore } from '../../src/redis/index.js';
const url = process.env.REDIS_URL;
const suite = url ? describe : describe.skip;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
suite('global leases and notifications', () => {
  it.each(['ioredis', 'node-redis-v4', 'node-redis-v5'] as const)(
    'renews and releases shared slots and wakes immediately with %s',
    async (kind) => {
      const client =
        kind === 'ioredis'
          ? new Redis(url!)
          : kind === 'node-redis-v4'
            ? createV4({ url: url! })
            : createV5({ url: url! });
      const subscriber = client.duplicate();
      if (kind !== 'ioredis') {
        await (client as ReturnType<typeof createV4>).connect();
        await (subscriber as ReturnType<typeof createV4>).connect();
      }
      const id = `global-${kind}-${Date.now()}`;
      const store = redisStore({ client, subscriber });
      const first = createValve({
        id,
        concurrency: { limit: 1, scope: 'global', leaseTtl: 300 },
        store,
      });
      const second = createValve({
        id,
        concurrency: { limit: 1, scope: 'global', leaseTtl: 300 },
        store,
      });
      let running = 0,
        peak = 0;
      const work = async () => {
        peak = Math.max(peak, ++running);
        await sleep(400);
        running--;
      };
      try {
        await Promise.all([first.run(work), second.run(work)]);
        expect(peak).toBe(1);
        await first.pause(10000);
        const queued = second.run(() => 42);
        await sleep(50);
        expect(second.stats().queued).toBe(1);
        const start = performance.now();
        await first.resume();
        expect(await queued).toBe(42);
        expect(performance.now() - start).toBeLessThan(150);
        const result = await store.acquire({
          id: `${id}-expire`,
          rules: [],
          costs: [1],
          lease: { limit: 1, ttlMs: 30, owner: 'old' },
        });
        await sleep(50);
        expect(await store.renew!(`${id}-expire`, result.leases!, 30)).toBe(
          false,
        );
      } finally {
        await first.close();
        await second.close();
        await store.close();
        await subscriber.quit();
        await client.quit();
      }
    },
  );
  it('holds a fleet bound across eight real processes', async () => {
    const id = `fleet-${Date.now()}`;
    const client = new Redis(url!);
    const script = fileURLToPath(
      new URL('./global-worker.mjs', import.meta.url),
    );
    const children = Array.from({ length: 8 }, () =>
      fork(script, [url!, id], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }),
    );
    try {
      await Promise.all(
        children.map(async (child) => {
          const [code] = await once(child, 'exit');
          expect(code).toBe(0);
        }),
      );
      expect(
        Number(await client.get(`bench:{${id}}:peak`)),
      ).toBeLessThanOrEqual(4);
      expect(await client.get(`bench:{${id}}:running`)).toBe('0');
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
      await client.quit();
    }
  });
  it('recovers a slot after its owning process is killed', async () => {
    const id = `crash-${Date.now()}`;
    const script = fileURLToPath(
      new URL('./global-worker.mjs', import.meta.url),
    );
    const child = fork(script, [url!, id, 'hold'], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const client = new Redis(url!);
    const store = redisStore({ client });
    const api = createValve({
      id,
      concurrency: { limit: 1, scope: 'global', leaseTtl: 300 },
      store,
      maxWait: 2000,
    });
    try {
      await once(child, 'message');
      const exit = once(child, 'exit');
      child.kill('SIGKILL');
      await exit;
      const start = performance.now();
      expect(await api.run(() => 42)).toBe(42);
      expect(performance.now() - start).toBeLessThan(1000);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await api.close();
      await store.close();
      await client.quit();
    }
  });
});
