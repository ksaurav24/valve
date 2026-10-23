// Sequential composition on Redis: independent ids stay independent budgets.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis5';
import { createValve, runSequential } from '../../src/index.js';
import { redisStore } from '../../src/redis/index.js';
import type { Valve } from '../../src/index.js';

const url = process.env.REDIS_URL;
const suite = url ? describe : describe.skip;
const minute = { limit: 1, interval: '1m', algorithm: 'fixed-window' } as const;
const until = async (ready: () => boolean) => {
  for (let i = 0; i < 200 && !ready(); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(ready()).toBe(true);
};
suite('runSequential on Redis/Valkey', () => {
  const client = new Redis(url!, { lazyConnect: true });
  const prefix = `sequential-${randomUUID()}`;
  const store = redisStore({ client, prefix });
  const opened: Valve[] = [];
  const valve = (options: Parameters<typeof createValve>[0]) => {
    const created = createValve({ ...options, store });
    opened.push(created);
    return created;
  };
  beforeAll(() => client.connect());
  afterAll(async () => {
    await Promise.all(opened.map((v) => v.close()));
    const keys = await client.keys(`${prefix}:*`);
    if (keys.length) await client.del(...keys);
    await store.close();
    client.disconnect();
  });

  it('keeps an earlier id spent for every worker when a later id rejects', async () => {
    const ingress = `ingress-${randomUUID()}`;
    const tenant = `tenant-${randomUUID()}`;
    const workerA = { ingress: valve({ id: ingress, rate: minute }) };
    const workerB = {
      ingress: valve({ id: ingress, rate: minute }),
      tenant: valve({ id: tenant, rate: minute }),
    };
    await workerB.tenant.run(() => 'exhaust tenant');
    await expect(
      runSequential(
        [
          { valve: workerA.ingress },
          {
            valve: valve({ id: tenant, rate: minute }),
            options: { maxWait: 0 },
          },
        ],
        () => 'never',
      ),
    ).rejects.toMatchObject({ code: 'MAX_WAIT_EXCEEDED', valveId: tenant });
    // The other worker shares the ingress id, so it sees the spent budget.
    await expect(
      workerB.ingress.run(() => 'x', { maxWait: 0 }),
    ).rejects.toMatchObject({ code: 'MAX_WAIT_EXCEEDED', valveId: ingress });
  });

  it('spends nothing when one atomic scoped admission is denied', async () => {
    const id = `atomic-${randomUUID()}`;
    const rate = [
      { name: 'ingress', limit: 2, interval: '1m', algorithm: 'fixed-window' },
      { name: 'tenant', scope: 'tenant', ...minute },
    ] as const;
    const first = valve({ id, rate });
    const second = valve({ id, rate });
    await first.run(() => 't1', { scopes: { tenant: 't1' } });
    await expect(
      second.run(() => 'never', { scopes: { tenant: 't1' }, maxWait: 0 }),
    ).rejects.toMatchObject({ code: 'MAX_WAIT_EXCEEDED' });
    await expect(
      first.run(() => 't2', { scopes: { tenant: 't2' }, maxWait: 0 }),
    ).resolves.toBe('t2');
  });

  it('holds the outer global lease across workers while a later stage waits', async () => {
    const outer = `outer-${randomUUID()}`;
    const inner = `inner-${randomUUID()}`;
    const global = { limit: 1, scope: 'global', leaseTtl: '1s' } as const;
    const a = valve({ id: outer, concurrency: global });
    const peer = valve({ id: outer, concurrency: global });
    const b = valve({ id: inner, concurrency: global });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const blocker = b.run(() => gate);
    try {
      await until(() => b.stats().running === 1);
      const nested = runSequential(
        [{ valve: a }, { valve: b }],
        () => 'nested',
      );
      await until(() => a.stats().running === 1 && b.stats().queued === 1);
      // Another worker sharing the outer id waits while its lease is held.
      await expect(
        peer.run(() => 'peer', { maxWait: 100 }),
      ).rejects.toMatchObject({ code: 'MAX_WAIT_EXCEEDED', valveId: outer });
      release();
      await expect(nested).resolves.toBe('nested');
      await expect(peer.run(() => 'peer')).resolves.toBe('peer');
    } finally {
      release();
      await blocker;
    }
  });

  it('feeds provider feedback only to the stage that observes it', async () => {
    const a = valve({ id: `feedback-a-${randomUUID()}`, concurrency: 1 });
    const b = valve({ id: `feedback-b-${randomUUID()}`, concurrency: 1 });
    const pauses = { a: 0, b: 0 };
    a.on('pause', () => pauses.a++);
    b.on('pause', () => pauses.b++);
    let observed = 0;
    await runSequential(
      [
        { valve: a },
        { valve: b, options: { observe: (r) => (observed++, r) } },
      ],
      () => ({ status: 429, headers: { 'retry-after': '60' } }),
    );
    expect({ observed, ...pauses }).toEqual({ observed: 1, a: 0, b: 1 });
    expect(a.stats().pausedUntil).toBeNull();
    expect(b.stats().pausedUntil).toBeGreaterThan(Date.now());
  });
});
