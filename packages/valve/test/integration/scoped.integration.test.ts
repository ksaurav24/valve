import { scopedCases } from '../scoped-cases.js';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis5';
import { createClient } from 'redis5';
import fc from 'fast-check';
import { createValve, memoryStore } from '../../src/index.js';
import { redisStore } from '../../src/redis/index.js';
import { normalize } from '../../src/rules.js';
import { prepareScoped } from '../../src/scoped.js';
import { SCOPED } from '../../src/redis/scripts.js';
import { withLuaClock } from '../lua-clock.js';
import type { RateRule } from '../../src/types.js';

const url = process.env.REDIS_URL;
const suite = url ? describe : describe.skip;
suite('scoped Redis/Valkey admission', () => {
  const io = new Redis(url!, { lazyConnect: true });
  const node = createClient({ url: url! });
  const prefix = `scoped-${randomUUID()}`;
  const store = redisStore({ client: io, prefix });
  const other = redisStore({ client: node, prefix });
  const rate: RateRule[] = [
    { name: 'shared', limit: 3, interval: 60000, algorithm: 'fixed-window' },
    { name: 'recipient', scope: 'recipient', limit: 1, interval: 60000 },
  ];
  const make = (id: string, recipients = ['A', 'A', 'B', 'C']) => ({
    id,
    rules: normalize({ id, rate }).rules,
    jobs: recipients.map((recipient) => ({ cost: 1, scopes: { recipient } })),
  });
  beforeAll(async () => {
    await io.connect();
    await node.connect();
  });
  afterAll(async () => {
    const keys = await io.keys(`${prefix}:*`);
    if (keys.length) await io.del(...keys);
    await store.close();
    await other.close();
    await io.quit();
    await node.quit();
  });
  it.each(scopedCases)('$name', async ({ rate, steps }) => {
    const id = randomUUID();
    const rules = normalize({ id, rate }).rules;
    for (const step of steps) {
      const plan = prepareScoped({ id, rules, jobs: step.jobs });
      const keys = ['config', 'pause', 'leases', ...plan.keys].map(
        (key) => `${prefix}:{${id}}:${key}`,
      );
      expect(
        await io.eval(
          withLuaClock(SCOPED),
          keys.length,
          ...keys,
          JSON.stringify(plan),
          step.now,
        ),
      ).toEqual([
        step.expected.grantedIndexes,
        step.expected.blocked.map((b) => [b.index, b.retryAfterMs]),
        [],
        0,
      ]);
    }
  });
  it('reports a shared pause on scoped admission', async () => {
    const request = make(randomUUID(), ['A']);
    await store.pause(request.id, 1000);
    const result = await store.acquireScoped!(request);
    expect(result.grantedIndexes).toEqual([]);
    expect(result.pausedMs).toBeGreaterThan(900);
    expect(result.blocked[0]!.retryAfterMs).toBe(result.pausedMs);
  });
  it('reports whether leases or rate rules denied scoped jobs', async () => {
    const request = {
      ...make(randomUUID(), ['A', 'A', 'B']),
      lease: { limit: 1, ttlMs: 30000, owner: 'o' },
    };
    const result = await store.acquireScoped!(request);
    expect(result.grantedIndexes).toEqual([0]);
    expect(result.blocked.map((b) => [b.index, b.leaseBlocked])).toEqual([
      [1, false],
      [2, true],
    ]);
  });
  it('expires inactive scoped keys automatically and restores their budgets', async () => {
    const id = 'expiry';
    const rules = normalize({
      id,
      rate: [
        {
          name: 'pacing',
          scope: 'recipient',
          limit: 1,
          interval: 500,
          burst: 2,
        },
        {
          name: 'window',
          scope: 'recipient',
          limit: 2,
          interval: 500,
          algorithm: 'fixed-window',
        },
      ],
    }).rules;
    const req = { id, rules, jobs: [{ cost: 2, scopes: { recipient: 'A' } }] };
    expect((await store.acquireScoped!(req)).grantedIndexes).toEqual([0]);
    const pacing = `${prefix}:{${id}}:s:named:pacing:A`;
    const window = `${prefix}:{${id}}:s:named:window:A`;
    // Read time, TTL and state together: no network latency in the expiry comparison.
    // TIME + PTTL works on Redis 6.2; PEXPIRETIME requires Redis 7.
    const snapshot = (await io.eval(
      `
      local t = redis.call('TIME')
      return {tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000),
        redis.call('PTTL', KEYS[1]), redis.call('GET', KEYS[1]),
        redis.call('PTTL', KEYS[2]), redis.call('HGET', KEYS[2], 'w')}
    `,
      2,
      pacing,
      window,
    )) as [number, number, string, number, string | null];
    const [now, pacingTtl, tat, windowTtl, windowIndex] = snapshot;
    expect(pacingTtl).toBeGreaterThan(0);
    expect(
      Math.abs(now + pacingTtl - Math.ceil(Number(tat))),
    ).toBeLessThanOrEqual(1);
    // The fixed window may have ended between admission and this snapshot.
    if (windowIndex === null) expect(windowTtl).toBe(-2);
    else {
      expect(windowTtl).toBeGreaterThanOrEqual(0);
      expect(
        Math.abs(now + windowTtl - (Number(windowIndex) + 1) * 500),
      ).toBeLessThanOrEqual(1);
    }
    await expect
      .poll(() => io.exists(pacing, window), { timeout: 3000 })
      .toBe(0);
    expect(await io.pttl(`${prefix}:{${id}}:config`)).toBe(-1);
    expect((await other.acquireScoped!(req)).grantedIndexes).toEqual([0]);
  });
  it('grants sparsely, shares state across clients and recovers NOSCRIPT', async () => {
    const req = make('sparse');
    expect((await store.acquireScoped!(req)).grantedIndexes).toEqual([0, 2, 3]);
    await io.script('FLUSH');
    expect(
      (
        await other.acquireScoped!({
          ...req,
          jobs: [{ cost: 1, scopes: { recipient: 'D' } }],
        })
      ).grantedIndexes,
    ).toEqual([]);
    expect((await other.acquireScoped!(make('fresh'))).grantedIndexes).toEqual([
      0, 2, 3,
    ]);
    for (const key of await io.keys(`${prefix}:{sparse}:*`))
      if (!key.endsWith(':config'))
        expect(await io.pttl(key)).toBeGreaterThan(0);
    expect(await io.pttl(`${prefix}:{sparse}:config`)).toBe(-1);
  });
  it('isolates punctuation, braces, Unicode and rule names in one hash tag', async () => {
    const req = make('identities', ['a:b', 'a%3Ab', '{x}', 'é']);
    req.rules = normalize({
      id: req.id,
      rate: [{ name: 'r', scope: 'recipient', limit: 1, interval: 60000 }],
    }).rules;
    expect((await store.acquireScoped!(req)).grantedIndexes).toEqual([
      0, 1, 2, 3,
    ]);
    const keys = await io.keys(`${prefix}:{identities}:s:*`);
    expect(keys).toHaveLength(4);
    expect(keys.every((key) => (key.match(/[{}]/g) ?? []).length === 2)).toBe(
      true,
    );
  });
  it('fails incompatible policy before mutation, even while paused', async () => {
    const req = make('config', ['A']);
    await store.acquireScoped!(req);
    await store.pause(req.id, 5000);
    const before = await io.dump(`${prefix}:{config}:r:named:shared`);
    await expect(
      other.acquireScoped!({
        ...req,
        rules: req.rules.map((r) => ({ ...r, limit: r.limit + 1 })),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(await io.dump(`${prefix}:{config}:r:named:shared`)).toEqual(before);
    await expect(
      store.acquire({ id: req.id, rules: [], costs: [1] }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
  });
  it('preflights a wrong-type later key before writing config, earlier budgets or leases', async () => {
    const req = {
      ...make('wrong', ['A', 'B']),
      lease: { limit: 2, ttlMs: 300, owner: 'owner' },
    };
    const key = `${prefix}:{wrong}:s:named:recipient:B`;
    await io.lpush(key, 'wrong');
    await expect(store.acquireScoped!(req)).rejects.toThrow(/key type/);
    expect((await io.keys(`${prefix}:{wrong}:*`)).sort()).toEqual([key]);
    await io.del(key);
    await io.set(key, 'not-a-number');
    await expect(store.acquireScoped!(req)).rejects.toThrow(/state/);
    expect((await io.keys(`${prefix}:{wrong}:*`)).sort()).toEqual([key]);
  });
  it('issues only admitted leases and supports release/renew', async () => {
    const req = {
      ...make('leases'),
      lease: { limit: 2, ttlMs: 1000, owner: 'first' },
    };
    const result = await store.acquireScoped!(req);
    expect(result.grantedIndexes).toEqual([0, 2]);
    expect(result.leases).toEqual([
      { index: 0, token: 'first:0' },
      { index: 2, token: 'first:2' },
    ]);
    expect(await store.renew!(req.id, ['first:0', 'first:2'], 1000)).toBe(true);
    await other.release!(req.id, ['first:0']);
    expect(
      (
        await store.acquireScoped!({
          ...req,
          jobs: [{ cost: 1, scopes: { recipient: 'C' } }],
          lease: { ...req.lease, owner: 'second' },
        })
      ).grantedIndexes,
    ).toEqual([0]);
  });
  it('matches deterministic memory across generated sparse weighted batches', async () => {
    const source = withLuaClock(SCOPED);
    const cases = fc.sample(
      fc.record({
        limit: fc.integer({ min: 2, max: 20 }),
        interval: fc.integer({ min: 10, max: 1000 }),
        batches: fc.array(
          fc.record({
            gap: fc.integer({ min: 0, max: 1000 }),
            recipients: fc.array(fc.integer({ min: 0, max: 4 }), {
              minLength: 1,
              maxLength: 20,
            }),
          }),
          { minLength: 2, maxLength: 8 },
        ),
      }),
      { seed: 52, numRuns: 100 },
    );
    for (const [i, sample] of cases.entries()) {
      let now = 4102444800000;
      const memory = memoryStore({ clock: () => now });
      const id = `parity-${i}`;
      const rules = normalize({
        id,
        rate: [
          {
            limit: sample.limit,
            interval: sample.interval,
            algorithm: 'fixed-window',
          },
          {
            name: 'r',
            scope: 'recipient',
            limit: 3,
            burst: 3,
            interval: sample.interval,
          },
          {
            name: 'day',
            scope: 'recipient',
            limit: sample.limit,
            interval: sample.interval * 3,
            algorithm: 'fixed-window',
          },
        ],
      }).rules;
      for (const batch of sample.batches) {
        now += batch.gap;
        const req = {
          id,
          rules,
          jobs: batch.recipients.map((r) => ({
            cost: (r % 2) + 1,
            scopes: { recipient: String(r) },
          })),
        };
        const plan = prepareScoped(req);
        const keys = [
          `${prefix}:{${id}}:config`,
          `${prefix}:{${id}}:pause`,
          `${prefix}:{${id}}:leases`,
          ...plan.keys.map((key) => `${prefix}:{${id}}:${key}`),
        ];
        const expected = memory.acquireScopedSync!(req);
        const raw = await io.eval(
          source,
          keys.length,
          ...keys,
          JSON.stringify(plan),
          now,
        );
        expect(raw, `${id} at ${now}`).toEqual([
          expected.grantedIndexes,
          expected.blocked.map((b) => [b.index, b.retryAfterMs]),
          [],
          expected.pausedMs ?? 0,
        ]);
      }
      await memory.close();
    }
  });
  it('does not start a timed-out command even if Redis committed its budgets', async () => {
    const adapter = {
      evalsha: async (sha: string, keys: string[], args: string[]) => {
        const result = await io.evalsha(sha, keys.length, ...keys, ...args);
        await new Promise((resolve) => setTimeout(resolve, 50));
        return result;
      },
      eval: async (script: string, keys: string[], args: string[]) => {
        const result = await io.eval(script, keys.length, ...keys, ...args);
        await new Promise((resolve) => setTimeout(resolve, 50));
        return result;
      },
    };
    const slow = redisStore({ adapter, prefix, timeout: 10 });
    const id = 'unknown-result';
    const policy: RateRule[] = [
      { name: 'all', limit: 1, interval: '24h', algorithm: 'fixed-window' },
      { name: 'r', scope: 'recipient', limit: 1, interval: '24h' },
    ];
    const api = createValve({
      id,
      rate: policy,
      store: slow,
      onStoreError: 'throw',
    });
    let ran = false;
    try {
      await expect(
        api.run(
          () => {
            ran = true;
          },
          { scopes: { recipient: 'A' } },
        ),
      ).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(ran).toBe(false);
      const result = await store.acquireScoped!({
        id,
        rules: normalize({ id, rate: policy }).rules,
        jobs: [{ cost: 1, scopes: { recipient: 'B' } }],
      });
      expect(result.grantedIndexes).toEqual([]);
    } finally {
      await api.close();
      await slow.close();
    }
  });
  it('retains scoped state after client reconnect and exposes state-loss limits', async () => {
    const client = new Redis(url!, { lazyConnect: true });
    await client.connect();
    const connected = redisStore({ client, prefix });
    const req = make('reconnect');
    try {
      expect((await connected.acquireScoped!(req)).grantedIndexes).toEqual([
        0, 2, 3,
      ]);
      client.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await client.connect();
      expect((await connected.acquireScoped!(req)).grantedIndexes).toEqual([]);
      // An isolated namespace deletion models loss of non-durable Redis state.
      const keys = await client.keys(`${prefix}:{reconnect}:*`);
      await client.del(...keys);
      expect((await connected.acquireScoped!(req)).grantedIndexes).toEqual([
        0, 2, 3,
      ]);
    } finally {
      await connected.close();
      await client.quit();
    }
  });
  it('bounds combined admissions across independent processes', async () => {
    const id = `process-${randomUUID()}`;
    const children: ReturnType<typeof fork>[] = [];
    let ready = 0;
    const run = () =>
      new Promise<string[]>((resolve, reject) => {
        const child = fork(
          new URL('./scoped-worker.mjs', import.meta.url),
          [],
          {
            env: {
              ...process.env,
              REDIS_URL: url!,
              SCOPED_ID: id,
              SCOPED_PREFIX: prefix,
            },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          },
        );
        children.push(child);
        let result: string[] | undefined;
        let stderr = '';
        child.stderr!.on('data', (data) => {
          stderr += String(data);
        });
        child.on('message', (value) => {
          if (value === 'ready') {
            if (++ready === 4) for (const worker of children) worker.send('go');
          } else if (Array.isArray(value)) result = value;
        });
        child.on('error', reject);
        child.on('exit', (code) =>
          code === 0 && result !== undefined
            ? resolve(result)
            : reject(new Error(stderr || `worker exit ${code}`)),
        );
      });
    try {
      const admitted = (await Promise.all([run(), run(), run(), run()])).flat();
      expect(admitted).toHaveLength(10);
      expect(new Set(admitted).size).toBe(10);
    } finally {
      for (const child of children) child.kill();
    }
  });
});
