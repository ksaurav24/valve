// Authoritative runtime limits, migration, corruption, and memory/Lua parity.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Redis } from 'ioredis5';
import { createClient } from 'redis5';
import fc from 'fast-check';
import { createValve, memoryStore } from '../../src/index.js';
import { normalize } from '../../src/rules.js';
import { redisStore } from '../../src/redis/index.js';
import { MANAGED } from '../../src/redis/scripts.js';
import { withLuaClock } from '../lua-clock.js';
import type { RateRule } from '../../src/types.js';

const url = process.env.REDIS_URL;
(url ? describe : describe.skip)('managed Redis limits', () => {
  const io = new Redis(url!, { lazyConnect: true });
  const node = createClient({ url: url! });
  const prefix = `managed-${crypto.randomUUID()}`;
  const store = redisStore({ client: io, prefix });
  const peer = redisStore({ client: node, prefix });
  const rate = { name: 'throughput', limit: 10, interval: 60000, burst: 10 };
  const context = (
    id: string,
    rules: RateRule | readonly RateRule[] = rate,
  ) => ({
    id,
    rules: normalize({ id, rate: rules, limits: 'managed' }).rules,
  });
  beforeAll(async () => {
    await io.connect();
    await node.connect();
  });
  afterAll(async () => {
    await store.close();
    await peer.close();
    const keys = await io.keys(`${prefix}:*`);
    if (keys.length) await io.del(...keys);
    await io.quit();
    await node.quit();
  });

  it('preserves fixed-window counts on raises and decreases across client families', async () => {
    const ctx = context('fixed', {
      ...rate,
      algorithm: 'fixed-window',
      interval: 86400000,
    });
    expect(
      (await store.managed!.acquire({ ...ctx, costs: [4, 4] })).granted,
    ).toBe(2);
    await peer.managed!.updateLimits({
      ...ctx,
      patch: { throughput: { limit: 12 } },
    });
    expect(
      (await store.managed!.acquire({ ...ctx, costs: [4, 1] })).granted,
    ).toBe(1);
    await peer.managed!.updateLimits({
      ...ctx,
      patch: { throughput: { limit: 5 } },
    });
    expect((await store.managed!.acquire({ ...ctx, costs: [1] })).granted).toBe(
      0,
    );
    expect(await io.hget(`${prefix}:{fixed}:r:named:throughput`, 'n')).toBe(
      '12',
    );
  });

  it('composes concurrent field patches, supports retry-safe expect, and rejects conflicts atomically', async () => {
    const ctx = context('patches', [rate, { ...rate, name: 'daily' }]);
    await store.managed!.getLimits(ctx);
    await Promise.all([
      store.managed!.updateLimits({
        ...ctx,
        patch: { throughput: { limit: 20 } },
      }),
      peer.managed!.updateLimits({
        ...ctx,
        patch: { throughput: { burst: 30 }, daily: { limit: 40 } },
      }),
    ]);
    const snapshot = await store.managed!.getLimits(ctx);
    expect(snapshot.rules.throughput).toMatchObject({ limit: 20, burst: 30 });
    expect(snapshot.rules.daily!.limit).toBe(40);
    expect(snapshot.revision).toBe(3);
    expect(
      (
        await peer.managed!.updateLimits({
          ...ctx,
          patch: { throughput: { limit: 20 } },
          expect: { throughput: { limit: 10 } },
        })
      ).version,
    ).toBe(snapshot.version);
    await expect(
      peer.managed!.updateLimits({
        ...ctx,
        patch: { throughput: { limit: 99 }, daily: { limit: 99 } },
        expect: { throughput: { limit: 10 } },
      }),
    ).rejects.toMatchObject({ code: 'LIMITS_CONFLICT' });
    expect((await store.managed!.getLimits(ctx)).version).toBe(
      snapshot.version,
    );
  });

  it('allows names matching internal metadata fields', async () => {
    const ctx = context(
      'names',
      ['v', 'e', 'r', 's', 'p', 'u'].map((name) => ({ ...rate, name })),
    );
    expect((await store.managed!.acquire({ ...ctx, costs: [1] })).granted).toBe(
      1,
    );
    await store.managed!.updateLimits({
      ...ctx,
      patch: { r: { limit: 20 }, v: { burst: 20 } },
    });
    expect((await peer.managed!.getLimits(ctx)).rules.r!.limit).toBe(20);
  });

  it.each([false, true])(
    'preserves leases and shared pause through updates (scoped=%s)',
    async (scoped) => {
      const id = `managed-lease-${scoped}`;
      const ctx = {
        ...context(id, {
          ...rate,
          limit: 2,
          burst: 2,
          ...(scoped ? { scope: 'recipient' } : {}),
        }),
        lease: { limit: 1, ttlMs: 10000, owner: 'first' },
      };
      const acquire = async (owner: string) => {
        const request = { ...ctx, lease: { ...ctx.lease, owner } };
        if (!scoped) return store.managed!.acquire({ ...request, costs: [1] });
        const result = await store.managed!.acquireScoped!({
          ...request,
          jobs: [{ cost: 1, scopes: { recipient: 'A' } }],
        });
        return {
          granted: result.grantedIndexes.length,
          pausedMs: result.pausedMs ?? 0,
          leaseBlocked: result.blocked[0]?.leaseBlocked,
          leases: result.leases?.map((value) => value.token) ?? [],
        };
      };
      const first = await acquire('first');
      expect(first.granted).toBe(1);
      await peer.managed!.updateLimits({
        ...ctx,
        patch: { throughput: { limit: 1 } },
      });
      expect(await store.renew!(id, first.leases!, 10000)).toBe(true);
      const blocked = await acquire('second');
      expect(blocked).toMatchObject({ granted: 0, leaseBlocked: true });
      await store.pause(id, 60000);
      await store.release!(id, first.leases!);
      expect((await acquire('third')).pausedMs).toBeGreaterThan(0);
      await store.resume(id);
      expect((await acquire('fourth')).granted).toBe(1);
      const tokens = await io.zrange(`${prefix}:{${id}}:leases`, 0, -1);
      expect(tokens).toHaveLength(1);
      await store.release!(id, tokens);
    },
  );

  it('adopts immutable state and rejects immutable or structurally incompatible workers after update', async () => {
    const ctx = context('adopt');
    expect((await store.acquire({ ...ctx, costs: [10] })).granted).toBe(1);
    expect((await peer.managed!.acquire({ ...ctx, costs: [1] })).granted).toBe(
      0,
    );
    expect((await store.acquire({ ...ctx, costs: [1] })).granted).toBe(0);
    await peer.managed!.updateLimits({
      ...ctx,
      patch: { throughput: { limit: 20 } },
    });
    await expect(store.acquire({ ...ctx, costs: [1] })).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    });
    await expect(
      store.managed!.getLimits(context('adopt', { ...rate, interval: 120000 })),
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    const next = await store.managed!.acquire({ ...ctx, costs: [1] });
    expect(next.granted).toBe(0);
    expect(next.retryAfterMs).toBeGreaterThan(2000);
    expect(next.retryAfterMs).toBeLessThanOrEqual(3000);
  });

  it('restores an evicted config without overwriting limits and re-registers from observed seeds after metadata loss', async () => {
    const ctx = context('loss');
    await store.managed!.acquire({ ...ctx, costs: [10] });
    const updated = await store.managed!.updateLimits({
      ...ctx,
      patch: { throughput: { limit: 1 } },
    });
    await io.del(`${prefix}:{loss}:config`);
    expect((await peer.managed!.getLimits(ctx)).version).toBe(updated.version);
    await io.del(`${prefix}:{loss}:limits`);
    const recovered = await store.managed!.getLimits(
      context('loss', { ...rate, limit: 1 }),
    );
    expect(recovered.version).not.toBe(updated.version);
    expect(recovered.rules.throughput!.limit).toBe(1);
    const result = await store.managed!.acquire({ ...ctx, costs: [1] });
    expect(result.retryAfterMs).toBeLessThanOrEqual(60000);
  });

  it.each(['limits', 'rate', 'leases'] as const)(
    'fails closed on corrupt %s data with open failure policy',
    async (kind) => {
      const id = `corrupt-${kind}`;
      const ctx = context(id);
      await store.managed!.getLimits(ctx);
      const key = `${prefix}:{${id}}:${kind === 'rate' ? 'r:named:throughput' : kind}`;
      await io.del(key);
      await io.lpush(key, 'bad');
      const api = createValve({
        id,
        rate,
        store,
        limits: 'managed',
        onStoreError: 'open',
      });
      const fn = vi.fn();
      try {
        if (kind === 'leases') {
          // Lease state is unused by local concurrency; use a matching global context instead.
          await io.del(`${prefix}:{${id}}:config`, `${prefix}:{${id}}:limits`);
          await expect(
            store.managed!.acquire({
              ...ctx,
              costs: [1],
              lease: { limit: 1, ttlMs: 1000, owner: 'bad' },
            }),
          ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
          expect(await io.exists(`${prefix}:{${id}}:limits`)).toBe(0);
        } else
          await expect(api.run(fn)).rejects.toMatchObject({
            code: 'INVALID_OPTIONS',
          });
        expect(fn).not.toHaveBeenCalled();
      } finally {
        await api.close();
      }
    },
  );

  it.each([false, true])(
    'wakes queued work after a remote raise (subscriber=%s)',
    async (subscribed) => {
      const subscriber = subscribed ? io.duplicate() : undefined;
      const waitingStore = redisStore({
        client: io,
        prefix,
        ...(subscriber ? { subscriber } : {}),
      });
      const id = `wake-${subscribed}`;
      if (subscribed) (await waitingStore.subscribe!(id, () => {}))();
      const slow = { ...rate, limit: 1, burst: 1, interval: 60000 };
      const api = createValve({
        id,
        rate: slow,
        store: waitingStore,
        limits: 'managed',
        maxWait: 5000,
      });
      try {
        await api.run(() => 1);
        const pending = api.run(() => 42);
        await peer.managed!.updateLimits({
          ...context(id, slow),
          patch: { throughput: { burst: 2 } },
        });
        await expect(pending).resolves.toBe(42);
      } finally {
        await api.close();
        await waitingStore.close();
        await subscriber?.quit();
      }
    },
  );

  it('rejects precision-destroying patches without committing, and fails closed on corrupt frames', async () => {
    const id = 'precision';
    const ctx = context(id);
    const original = await store.managed!.getLimits(ctx);
    await expect(
      store.managed!.updateLimits({
        ...ctx,
        patch: { throughput: { limit: Number.MAX_SAFE_INTEGER } },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    expect((await peer.managed!.getLimits(ctx)).version).toBe(original.version);
    const key = `${prefix}:{${id}}:limits`;
    const packed = (await io.hget(key, 'n:throughput'))!;
    const api = createValve({
      id,
      rate,
      limits: 'managed',
      store,
      onStoreError: 'open',
    });
    const fn = vi.fn();
    try {
      const fields = packed.split(' ');
      fields[5] = '1e300';
      await io.hset(key, 'n:throughput', fields.join(' '));
      await expect(api.run(fn)).rejects.toMatchObject({
        code: 'INVALID_OPTIONS',
      });
      await io.hset(key, 'n:throughput', packed, 'e', 'corrupt');
      await expect(api.run(fn)).rejects.toMatchObject({
        code: 'INVALID_OPTIONS',
      });
      expect(fn).not.toHaveBeenCalled();
      expect(await io.hget(key, 'r')).toBe('1');
    } finally {
      await api.close();
    }
  });

  it('keeps large revision tokens decimal and rejects revision exhaustion before writes', async () => {
    const ctx = context('revision-boundary');
    await store.managed!.getLimits(ctx);
    const key = `${prefix}:{revision-boundary}:limits`;
    await io.hset(key, 'r', String(Number.MAX_SAFE_INTEGER));
    const before = await store.managed!.getLimits(ctx);
    expect(before.revision).toBe(Number.MAX_SAFE_INTEGER);
    expect(before.version.endsWith(`.${Number.MAX_SAFE_INTEGER}`)).toBe(true);
    await expect(
      store.managed!.updateLimits({
        ...ctx,
        patch: { throughput: { limit: 20 } },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    expect((await store.managed!.getLimits(ctx)).version).toBe(before.version);
  });

  it('retains fractional debt across 3598 rate rebases in Lua', async () => {
    let now = Date.now() + 60000;
    const source = withLuaClock(MANAGED);
    const sha = String(await io.script('LOAD', source));
    const clocked = redisStore({
      prefix,
      adapter: {
        evalsha: (_sha, keys, args) =>
          io.evalsha(sha, keys.length, ...keys, ...args, String(now)),
        eval: (_script, keys, args) =>
          io.eval(source, keys.length, ...keys, ...args, String(now)),
      },
    });
    const ctx = context('rebase-rounding', {
      name: 'r',
      interval: 18,
      limit: 43,
      burst: 1000,
    });
    expect(
      (await clocked.managed!.acquire({ ...ctx, costs: [1000] })).granted,
    ).toBe(1);
    for (let i = 0; i < 3598; i++) {
      now++;
      await clocked.managed!.updateLimits({
        ...ctx,
        patch: { r: { limit: i % 2 ? 6 : 2 } },
      });
    }
    expect(
      (await clocked.managed!.acquire({ ...ctx, costs: [802] })).granted,
    ).toBe(0);
    expect(
      (await clocked.managed!.acquire({ ...ctx, costs: [801] })).granted,
    ).toBe(1);
    await clocked.close();
  });

  it.each([false, true])(
    'matches memory across random multi-revision histories (scoped=%s)',
    async (scoped) => {
      let now = 4102444800000;
      // Redis expiry uses its wall clock; mirror it on the simulated clock too,
      // so cold identities really disappear when their original TTL runs out.
      const source = `local actualRedis = redis
local mockNow = tonumber(ARGV[#ARGV])
local expiries = KEYS[1] .. ':test-expiries'
local redis = {call = function(command, ...)
  local args = {...}
  if command == 'GET' or command == 'HMGET' then
    local endAt = tonumber(actualRedis.call('HGET', expiries, args[1]))
    if endAt and endAt <= mockNow then
      actualRedis.call('DEL', args[1]); actualRedis.call('HDEL', expiries, args[1])
    end
  end
  if command == 'PEXPIREAT' then actualRedis.call('HSET', expiries, args[1], args[2]) end
  if command == 'PEXPIRE' then actualRedis.call('HSET', expiries, args[1], mockNow + args[2]) end
  if command == 'SET' and args[3] == 'PXAT' then actualRedis.call('HSET', expiries, args[1], args[4]) end
  return actualRedis.call(command, ...)
end, pcall = actualRedis.pcall, replicate_commands = actualRedis.replicate_commands}
${withLuaClock(MANAGED).replaceAll('redis.pcall(', 'redis.call(')}`;
      const clocked = redisStore({
        prefix,
        adapter: {
          evalsha: async () => {
            throw new Error('NOSCRIPT');
          },
          eval: (_script, keys, args) =>
            io.eval(source, keys.length, ...keys, ...args, String(now)),
        },
      });
      const histories = fc.sample(
        fc.array(
          fc.record({
            gap: fc.integer({ min: 0, max: 80 }),
            limit: fc.integer({ min: 1, max: 40 }),
            burst: fc.integer({ min: 1, max: 20 }),
            cost: fc.integer({ min: 1, max: 25 }),
          }),
          { minLength: 20, maxLength: 20 },
        ),
        { seed: 20261022, numRuns: 30 },
      );
      for (const [i, history] of histories.entries()) {
        const memory = memoryStore({ clock: () => now });
        const ctx = context(`parity-${scoped}-${i}`, [
          {
            name: 'gcra',
            limit: 10,
            burst: 10,
            interval: 1000,
            ...(scoped ? { scope: 'recipient' } : {}),
          },
          {
            name: 'fixed',
            algorithm: 'fixed-window',
            limit: 20,
            interval: 1000,
          },
        ]);
        for (const [j, step] of history.entries()) {
          now += step.gap;
          if (j % 3 === 0) {
            const request = {
              ...ctx,
              patch: { gcra: { limit: step.limit, burst: step.burst } },
            };
            await memory.managed!.updateLimits(request);
            await clocked.managed!.updateLimits(request);
          }
          const staticRequest = { ...ctx, costs: [step.cost, 1] };
          const scopedRequest = {
            ...ctx,
            jobs: [
              {
                cost: step.cost,
                scopes: { recipient: j % 2 ? 'hot' : `cold-${j % 7}` },
              },
            ],
          };
          const expected = scoped
            ? await memory.managed!.acquireScoped!(scopedRequest)
            : await memory.managed!.acquire(staticRequest);
          const actual = scoped
            ? await clocked.managed!.acquireScoped!(scopedRequest)
            : await clocked.managed!.acquire(staticRequest);
          const e = { ...expected, limits: undefined };
          const a = {
            ...actual,
            limits: undefined,
            ...('granted' in actual
              ? { impossible: actual.impossible ?? false }
              : {}),
          };
          expect(a, `history ${i}, step ${j}`).toMatchObject(e);
        }
        await memory.close();
      }
      await clocked.close();
    },
  );

  it.each([8, 32])(
    'admits exactly the committed fixed budget across %s processes',
    async (workers) => {
      const id = `processes-${workers}`;
      const ctx = context(id, {
        name: 'budget',
        algorithm: 'fixed-window',
        limit: 16,
        interval: 86400000,
      });
      await store.managed!.getLimits(ctx);
      await store.managed!.updateLimits({
        ...ctx,
        patch: { budget: { limit: 23 } },
      });
      const results = await Promise.all(
        Array.from(
          { length: workers },
          () =>
            new Promise<number>((resolve, reject) => {
              const child = fork(
                fileURLToPath(new URL('./managed-worker.mjs', import.meta.url)),
                [url!, prefix, id],
                { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
              );
              let granted: number | undefined;
              let stderr = '';
              child.stderr?.on('data', (value) => {
                stderr += String(value);
              });
              child.on('message', (value) => {
                granted = (value as { granted: number }).granted;
              });
              child.on('error', reject);
              child.on('exit', (code) =>
                code === 0 && granted !== undefined
                  ? resolve(granted)
                  : reject(new Error(stderr || `worker exit ${code}`)),
              );
            }),
        ),
      );
      expect(results.reduce((sum, n) => sum + n, 0)).toBe(23);
    },
  );
});
