// Real Redis/Valkey parity, structural clients, shared pauses, and process bounds.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Redis } from 'ioredis5';
import { createClient as createV4 } from 'redis4';
import { createClient as createV5 } from 'redis5';
import { createValve, memoryStore } from '../../src/index.js';
import { redisStore } from '../../src/redis/index.js';
import { withLuaClock } from '../lua-clock.js';
import { ACQUIRE } from '../../src/redis/scripts.js';
import { normalize } from '../../src/rules.js';
import type { RedisStoreOptions } from '../../src/redis/index.js';
const url = process.env.REDIS_URL;
const suite = url ? describe : describe.skip;
suite('real Redis/Valkey', () => {
  const io = new Redis(url!, { lazyConnect: true });
  const v4 = createV4({ url: url! });
  const v5 = createV5({ url: url! });
  const prefix = `valve-test-${process.pid}`;
  beforeAll(async () => {
    await io.connect();
    await v4.connect();
    await v5.connect();
  });
  afterAll(async () => {
    await io.quit();
    await v4.quit();
    await v5.quit();
  });
  it.each(['ioredis', 'node-redis-v4', 'node-redis-v5'] as const)(
    'grants, pauses, resumes and recovers NOSCRIPT with %s',
    async (kind) => {
      const client =
        kind === 'ioredis' ? io : kind === 'node-redis-v4' ? v4 : v5;
      const store = redisStore({ client, prefix } as RedisStoreOptions);
      const id = `clients-${kind}`;
      const rules = normalize({
        id,
        rate: [
          { limit: 2, interval: 1000, burst: 2 },
          { limit: 2, interval: 1000, algorithm: 'fixed-window' },
        ],
      }).rules;
      expect(
        (await store.acquire({ id, rules, costs: [1, 1, 1] })).granted,
      ).toBe(2);
      await store.pause(id, 1000);
      await store.pause(id, 10);
      expect(
        (await store.acquire({ id, rules, costs: [1] })).pausedMs,
      ).toBeGreaterThan(900);
      await io.script('FLUSH');
      await store.resume(id);
      expect(
        (await store.acquire({ id: `${id}-fresh`, rules, costs: [1] })).granted,
      ).toBe(1);
      await store.close();
      expect(await io.ping()).toBe('PONG');
    },
  );
  it('matches TypeScript and Lua across 250 generated multi-rule batches', async () => {
    const source = withLuaClock(ACQUIRE);
    const cases = fc.sample(
      fc.record({
        limit: fc.integer({ min: 1, max: 20 }),
        interval: fc.integer({ min: 1, max: 1000 }),
        burst: fc.integer({ min: 1, max: 20 }),
        gaps: fc.array(fc.integer({ min: 0, max: 500 }), {
          minLength: 2,
          maxLength: 8,
        }),
        costs: fc.array(fc.integer({ min: 1, max: 5 }), {
          minLength: 1,
          maxLength: 10,
        }),
      }),
      { seed: 20261007, numRuns: 250 },
    );
    for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
      const data = cases[caseIndex]!;
      let now = 1791331200000;
      const memory = memoryStore({ clock: () => now });
      const id = `parity-${caseIndex}`;
      const rules = normalize({
        id,
        rate: [
          { limit: data.limit, interval: data.interval, burst: data.burst },
          {
            limit: data.limit,
            interval: data.interval * 2,
            algorithm: 'fixed-window',
          },
        ],
      }).rules;
      const keys = [
        `${prefix}:{${id}}:pause`,
        ...rules.map((r) => `${prefix}:{${id}}:r:${r.key}`),
      ];
      for (const gap of data.gaps) {
        now += gap;
        const expected = memory.acquireSync!({ id, rules, costs: data.costs });
        const args = [
          ...rules.flatMap((r) => [
            r.algorithm === 'gcra' ? 0 : 1,
            r.intervalMs,
            r.limit,
            r.burst,
          ]),
          data.costs.length,
          ...data.costs,
          now,
        ];
        const result = await io.eval(source, keys.length, ...keys, ...args);
        expect(result, `case ${caseIndex} at ${now}`).toEqual([
          expected.granted,
          expected.retryAfterMs,
          expected.pausedMs,
        ]);
      }
    }
  });
  it('keeps 5000 atomic admissions across eight child processes inside the global rolling bound', async () => {
    const id = `multiprocess-${process.pid}`;
    const script = fileURLToPath(new URL('./worker.mjs', import.meta.url));
    const children = Array.from({ length: 8 }, () =>
      fork(script, [url!, id, '625'], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      }),
    );
    try {
      await Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve, reject) => {
              let stderr = '';
              child.stderr?.on('data', (chunk) => {
                stderr += String(chunk);
              });
              child.on('error', reject);
              child.on('exit', (code) =>
                code === 0
                  ? resolve()
                  : reject(new Error(stderr || `child exited ${code}`)),
              );
            }),
        ),
      );
      const starts = (await io.lrange(`valve:{${id}}:pause:grants`, 0, -1))
        .map(Number)
        .sort((a, b) => a - b);
      expect(starts).toHaveLength(5000);
      let end = 0;
      for (let begin = 0; begin < starts.length; begin++) {
        while (end < starts.length && starts[end]! < starts[begin]! + 1000)
          end++;
        expect(end - begin).toBeLessThanOrEqual(1031);
      }
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
    }
  });
  it('one observed 429 pauses eight other processes for two seconds', async () => {
    const id = `pause-${process.pid}`;
    const script = fileURLToPath(new URL('./worker.mjs', import.meta.url));
    const children = Array.from({ length: 8 }, () =>
      fork(script, [url!, id, '2', 'pause'], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      }),
    );
    const exits = children.map(
      (child) =>
        new Promise<void>((resolve, reject) => {
          child.on('error', reject);
          child.on('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(`child exited ${code}`)),
          );
        }),
    );
    for (const exit of exits) void exit.catch(() => undefined);
    try {
      await Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve) =>
              child.once('message', () => resolve()),
            ),
        ),
      );
      const observer = createValve({
        id,
        concurrency: 1,
        store: redisStore({ client: io }),
      });
      observer.observe({ status: 429, headers: { 'Retry-After': '2' } });
      // observe returns before its write, so wait for store acknowledgement.
      let ttl = -2;
      for (let attempt = 0; attempt < 50 && ttl <= 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        ttl = await io.pttl(`valve:{${id}}:pause`);
      }
      expect(ttl).toBeGreaterThan(1800);
      for (const child of children) child.send({ start: true });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(await io.llen(`valve-test:{${id}}:starts`)).toBe(0);
      await Promise.all(exits);
      expect(await io.llen(`valve-test:{${id}}:starts`)).toBe(16);
      await observer.close();
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
    }
  });
  it.each(['wait', 'open', 'throw'] as const)(
    'uses %s policy on actual Redis timeouts and recovers',
    async (policy) => {
      const client = new Redis(url!, { lazyConnect: true });
      await client.connect();
      const store = redisStore({
        client,
        prefix: `${prefix}-down`,
        timeout: 30,
      });
      await io.call('CLIENT', 'PAUSE', '200', 'ALL');
      const api = createValve({
        id: `timeout-${policy}`,
        rate: { limit: 10, interval: 100, burst: 10 },
        store,
        onStoreError: policy,
        maxWait: 1000,
      });
      try {
        const task = api.run(() => 42);
        if (policy === 'throw')
          await expect(task).rejects.toMatchObject({
            code: 'STORE_UNAVAILABLE',
          });
        else expect(await task).toBe(42);
        expect(api.stats().totals.storeErrors).toBeGreaterThan(0);
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(await api.run(() => 7)).toBe(7);
      } finally {
        await api.close();
        await client.quit();
      }
    },
  );
});
