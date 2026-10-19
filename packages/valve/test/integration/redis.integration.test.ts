// Real Redis/Valkey parity, structural clients, shared pauses, and process bounds.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { Redis } from 'ioredis5';
import { createClient as createV4 } from 'redis4';
import { createClient as createV5 } from 'redis5';
import { createValve, memoryStore } from '../../src/index.js';
import { redisStore } from '../../src/redis/index.js';
import { withLuaClock } from '../lua-clock.js';
import { ACQUIRE } from '../../src/redis/scripts.js';
import { normalize } from '../../src/rules.js';
import type { Store } from '../../src/index.js';
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
  it.each(['local', 'global'] as const)(
    'rejects a granted callback at its deadline and frees %s concurrency',
    async (scope) => {
      const store = redisStore({ client: io, prefix });
      const acquire = vi.spyOn(store, 'acquire');
      const release = vi.spyOn(store, 'release');
      const api = createValve({
        id: `invocation-${scope}-${crypto.randomUUID()}`,
        store,
        concurrency:
          scope === 'global' ? { limit: 2, scope, leaseTtl: 10000 } : 2,
      });
      const fn = vi.fn();
      let clock: ReturnType<typeof vi.spyOn> | undefined;
      try {
        const submittedAt = Date.now();
        clock = vi.spyOn(Date, 'now').mockReturnValue(submittedAt);
        const first = api.run(() => {
          // Model a synchronous event-loop stall without timing-sensitive sleeps.
          clock!.mockReturnValue(submittedAt + 1000);
        });
        const second = api.run(fn, { maxWait: 1000 });
        const outcomes = await Promise.allSettled([first, second]);
        expect(acquire.mock.calls[0]![0].costs).toHaveLength(2);
        expect((await acquire.mock.results[0]!.value).granted).toBe(2);
        expect(outcomes[0]!.status).toBe('fulfilled');
        expect(outcomes[1]).toMatchObject({
          status: 'rejected',
          reason: { code: 'MAX_WAIT_EXCEEDED' },
        });
        expect(fn).not.toHaveBeenCalled();
        expect(api.stats()).toMatchObject({
          queued: 0,
          running: 0,
          totals: { started: 1, succeeded: 1, failed: 0, rejected: 1 },
        });
        clock?.mockRestore();
        const replacements = await Promise.all([
          api.run(() => 1),
          api.run(() => 2),
        ]);
        expect(replacements).toEqual([1, 2]);
        await api.close();
        if (scope === 'global') {
          const tokens = release.mock.calls.flatMap(([, leases]) => [
            ...leases,
          ]);
          expect(tokens).toHaveLength(4);
          expect(new Set(tokens).size).toBe(4);
        }
      } finally {
        clock?.mockRestore();
        await api.close();
        await store.close();
      }
    },
  );
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
      // Keys expire at absolute times derived from this clock, so it must
      // stay ahead of the server's real time for the whole run.
      let now = 4102444800000;
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
        `${prefix}:{${id}}:config`,
      ];
      for (const gap of data.gaps) {
        now += gap;
        const expected = memory.acquireSync!({ id, rules, costs: data.costs });
        const args = [
          `parity-${caseIndex}`,
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
      await io.del(...keys);
    }
  });
  it('keeps rate and lease keys alive until the times they store', async () => {
    // PEXPIRETIME needs Redis 7 or Valkey 7.2; Redis 6.2 skips the check.
    const version = /redis_version:(\d+)/.exec(await io.info('server'))?.[1];
    if (Number(version) < 7) return;
    const store = redisStore({ client: io, prefix });
    const rules = normalize({
      id: 'expiry',
      rate: { limit: 100, interval: 1000, burst: 1 },
    }).rules;
    for (let i = 0; i < 20; i++) {
      const id = `expiry-${i}`;
      const result = await store.acquire({
        id,
        rules,
        costs: [1],
        lease: { limit: 1, ttlMs: 50, owner: `owner-${i}` },
      });
      expect(result.granted).toBe(1);
      const rate = `${prefix}:{${id}}:r:${rules[0]!.key}`;
      const leases = `${prefix}:{${id}}:leases`;
      const arrival = Number(await io.get(rate));
      const [, lastLease] = await io.zrange(leases, -1, -1, 'WITHSCORES');
      // A relative TTL counted from Redis's millisecond snapshot expired these
      // keys up to 1ms early, letting the next admission start too soon.
      expect(Number(await io.call('PEXPIRETIME', rate))).toBeGreaterThanOrEqual(
        arrival,
      );
      expect(
        Number(await io.call('PEXPIRETIME', leases)),
      ).toBeGreaterThanOrEqual(Number(lastLease));
      expect(await store.renew!(id, result.leases!, 50)).toBe(true);
      const [, renewed] = await io.zrange(leases, -1, -1, 'WITHSCORES');
      expect(
        Number(await io.call('PEXPIRETIME', leases)),
      ).toBeGreaterThanOrEqual(Number(renewed));
      await io.del(rate, leases);
    }
    await store.close();
  });
  it('retries after the lease TTL when more jobs than free slots ask an empty slot set', async () => {
    const store = redisStore({ client: io, prefix });
    const id = `empty-slots-${process.pid}`;
    const result = await store.acquire({
      id,
      rules: [],
      costs: [1, 1],
      lease: { limit: 1, ttlMs: 1000, owner: 'o' },
    });
    expect(result).toMatchObject({ granted: 1, pausedMs: 0, leases: ['o:0'] });
    expect(result.retryAfterMs).toBeGreaterThan(900);
    expect(result.retryAfterMs).toBeLessThanOrEqual(1000);
    await io.del(...(await io.keys(`${prefix}:{${id}}:*`)));
    await store.close();
  });
  it('reports whether leases or rate rules denied an admission', async () => {
    const store = redisStore({ client: io, prefix });
    const id = `lease-blocked-${process.pid}`;
    const rules = normalize({ id, rate: { limit: 1, interval: 60000 } }).rules;
    const lease = { limit: 1, ttlMs: 60000, owner: 'a' };
    expect(await store.acquire({ id, rules, costs: [1], lease })).toMatchObject(
      { granted: 1, leaseBlocked: false },
    );
    expect(
      await store.acquire({
        id,
        rules,
        costs: [1],
        lease: { ...lease, owner: 'c' },
      }),
    ).toMatchObject({ granted: 0, leaseBlocked: true });
    await store.release!(id, ['a:0']);
    expect(
      await store.acquire({
        id,
        rules,
        costs: [1],
        lease: { ...lease, owner: 'b' },
      }),
    ).toMatchObject({ granted: 0, leaseBlocked: false });
    await io.del(...(await io.keys(`${prefix}:{${id}}:*`)));
    await store.close();
  });
  it('starts a fresh budget when Redis loses valve keys', async () => {
    // Documented limit: a flush, eviction, or stale failover erases admission
    // history, and Redis answers normally afterwards.
    const store = redisStore({ client: io, prefix });
    const id = `state-loss-${crypto.randomUUID()}`;
    const rules = normalize({
      id,
      rate: [
        { limit: 1, interval: 60000, burst: 1 },
        { limit: 1, interval: 60000, algorithm: 'fixed-window' },
      ],
    }).rules;
    const lease = { limit: 1, ttlMs: 60000, owner: 'state-loss' };
    const first = await store.acquire({ id, rules, costs: [1], lease });
    expect(first.granted).toBe(1);
    await store.pause(id, 60000);
    expect(
      (await store.acquire({ id, rules, costs: [1], lease })).granted,
    ).toBe(0);
    const keys = await io.keys(`${prefix}:{${id}}:*`);
    expect(keys.sort()).toEqual(
      [
        `${prefix}:{${id}}:pause`,
        ...rules.map((rule) => `${prefix}:{${id}}:r:${rule.key}`),
        `${prefix}:{${id}}:leases`,
        `${prefix}:{${id}}:config`,
      ].sort(),
    );
    await io.del(...keys);
    const other = { ...lease, owner: 'state-loss-other' };
    expect(
      (await store.acquire({ id, rules, costs: [1], lease: other })).granted,
    ).toBe(1);
    expect(await store.renew!(id, first.leases!, 60000)).toBe(false);
    await io.del(...(await io.keys(`${prefix}:{${id}}:*`)));
    await store.close();
  });
  it.each(['static', 'scoped'] as const)(
    'sends every %s maxWait 0 job to Redis like the memory store',
    async (policy) => {
      const counts = async (redis: boolean) => {
        const store = redis
          ? redisStore({ client: io, prefix: `${prefix}-zero` })
          : memoryStore();
        let sent = 0;
        const counted: Store = {
          ...store,
          acquire: (request: Parameters<typeof store.acquire>[0]) => {
            sent += request.costs.length;
            return store.acquire(request);
          },
          acquireScoped: (
            request: Parameters<NonNullable<typeof store.acquireScoped>>[0],
          ) => {
            sent += request.jobs.length;
            return store.acquireScoped!(request);
          },
        };
        delete counted.acquireSync;
        delete counted.acquireScopedSync;
        const api = createValve({
          id: `zero-${policy}-${redis}-${Date.now()}`,
          rate:
            policy === 'scoped'
              ? [{ name: 'r', scope: 'recipient', limit: 1, interval: '24h' }]
              : { limit: 1e9, interval: 1000, burst: 1e9 },
          concurrency: 64,
          batch: 32,
          store: counted,
        });
        const outcomes: Record<string, number> = {};
        await Promise.all(
          Array.from({ length: 512 }, (_, i) =>
            api
              .run(() => undefined, {
                maxWait: 0,
                ...(policy === 'scoped'
                  ? { scopes: { recipient: i % 2 ? `c${i}` : 'hot' } }
                  : {}),
              })
              .then(
                () => 'ok',
                (error: { code: string }) => error.code,
              )
              .then((key) => (outcomes[key] = (outcomes[key] ?? 0) + 1)),
          ),
        );
        await api.close();
        if (!redis) await store.close();
        return { sent, outcomes };
      };
      const memory = await counts(false);
      const redis = await counts(true);
      expect(memory.sent).toBe(512);
      expect(redis).toEqual(memory);
      expect(redis.outcomes.ok).toBe(policy === 'scoped' ? 257 : 512);
    },
  );
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
  it('keeps burst-1 admissions spaced by 10ms across eight contending processes', async () => {
    const id = `paced-${crypto.randomUUID()}`;
    const script = fileURLToPath(new URL('./worker.mjs', import.meta.url));
    const children = Array.from({ length: 8 }, () =>
      fork(script, [url!, id, '25', 'paced'], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      }),
    );
    const exits = children.map(
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
    );
    for (const exit of exits) void exit.catch(() => undefined);
    try {
      await Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve, reject) => {
              child.once('message', () => resolve());
              child.once('error', reject);
              child.once('exit', (code) =>
                reject(new Error(`worker exited before start: ${code}`)),
              );
            }),
        ),
      );
      for (const child of children) child.send({ start: true });
      await Promise.all(exits);
      const admissions = (
        await io.lrange(`valve:{${id}}:pause:grants`, 0, -1)
      ).map(Number);
      expect(admissions).toHaveLength(200);
      for (let i = 1; i < admissions.length; i++)
        expect(admissions[i]! - admissions[i - 1]!).toBeGreaterThanOrEqual(10);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
      await io.del(`valve:{${id}}:pause:grants`);
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
