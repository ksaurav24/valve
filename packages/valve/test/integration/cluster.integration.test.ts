// Both client families route one valve's hash-tagged keys to one cluster slot.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Cluster } from 'ioredis5';
import { createCluster } from 'redis5';
import { redisStore } from '../../src/redis/index.js';
import { createValve } from '../../src/index.js';
import { normalize } from '../../src/rules.js';
const url = process.env.REDIS_CLUSTER_URL;
const suite = url ? describe : describe.skip;
suite('Redis Cluster', () => {
  const target = new URL(url ?? 'redis://127.0.0.1:17300');
  const io = new Cluster(
    [{ host: target.hostname, port: Number(target.port) }],
    { lazyConnect: true },
  );
  const node = createCluster({
    rootNodes: [{ url: url ?? 'redis://127.0.0.1:17300' }],
  });
  beforeAll(async () => {
    await io.connect();
    await node.connect();
  });
  afterAll(async () => {
    await io.quit();
    await node.quit();
  });
  it.each([false, true])(
    'updates managed budgets atomically on one slot (scoped=%s)',
    async (scoped) => {
      const id = `managed-cluster-${crypto.randomUUID()}`;
      const rules = normalize({
        id,
        limits: 'managed',
        rate: [
          {
            name: 'budget',
            algorithm: 'fixed-window',
            limit: 2,
            interval: 60000,
          },
          {
            name: 'r',
            limit: 2,
            burst: 2,
            interval: 60000,
            ...(scoped ? { scope: 'recipient' } : {}),
          },
        ],
      }).rules;
      const a = redisStore({ client: io });
      const b = redisStore({ client: node });
      const context = { id, rules };
      const acquire = async () =>
        scoped
          ? (
              await a.managed!.acquireScoped!({
                ...context,
                jobs: [{ cost: 1, scopes: { recipient: 'A' } }],
              })
            ).grantedIndexes.length
          : (await a.managed!.acquire({ ...context, costs: [1] })).granted;
      expect(await acquire()).toBe(1);
      await b.managed!.updateLimits({
        ...context,
        patch: { budget: { limit: 1 }, r: { burst: 1 } },
      });
      expect(await acquire()).toBe(0);
      const keys = [
        'config',
        'limits',
        'pause',
        'leases',
        'events',
        'r:named:budget',
        scoped ? 's:named:r:A' : 'r:named:r',
      ].map((key) => `valve:{${id}}:${key}`);
      expect(
        new Set(
          await Promise.all(keys.map((key) => io.cluster('KEYSLOT', key))),
        ).size,
      ).toBe(1);
      await io.del(...keys);
      await a.close();
      await b.close();
    },
  );
  it('acquires and shares pauses with ioredis and node-redis', async () => {
    const id = `cluster-${process.pid}`;
    const a = redisStore({ client: io });
    const b = redisStore({ client: node });
    const rules = normalize({
      id,
      rate: [
        { limit: 5, interval: 1000, burst: 5 },
        { limit: 5, interval: 1000, algorithm: 'fixed-window' },
      ],
    }).rules;
    const keys = [
      `valve:{${id}}:pause`,
      ...rules.map((r) => `valve:{${id}}:r:${r.key}`),
    ];
    const slots = await Promise.all(
      keys.map((key) => io.cluster('KEYSLOT', key)),
    );
    expect(new Set(slots).size).toBe(1);
    expect((await a.acquire({ id, rules, costs: [1, 1] })).granted).toBe(2);
    expect((await b.acquire({ id, rules, costs: [1] })).granted).toBe(1);
    await a.pause(id, 1000);
    expect(
      (await b.acquire({ id, rules, costs: [1] })).pausedMs,
    ).toBeGreaterThan(0);
    await b.resume(id);
    expect((await a.acquire({ id, rules, costs: [1] })).granted).toBe(1);
  });
  it('admits scoped jobs atomically across client families on one slot', async () => {
    const id = `scoped-cluster-${crypto.randomUUID()}`;
    const rules = normalize({
      id,
      rate: [
        {
          name: 'shared',
          limit: 3,
          interval: 60000,
          algorithm: 'fixed-window',
        },
        { name: 'r', scope: 'recipient', limit: 1, interval: 60000 },
      ],
    }).rules;
    const a = redisStore({ client: io });
    const b = redisStore({ client: node });
    const req = {
      id,
      rules,
      jobs: ['A', 'A', 'B', 'C'].map((recipient) => ({
        cost: 1,
        scopes: { recipient },
      })),
    };
    expect((await a.acquireScoped!(req)).grantedIndexes).toEqual([0, 2, 3]);
    expect((await b.acquireScoped!(req)).grantedIndexes).toEqual([]);
    const keys = [
      'config',
      'pause',
      'leases',
      'r:named:shared',
      's:named:r:A',
      's:named:r:B',
    ].map((key) => `valve:{${id}}:${key}`);
    expect(
      new Set(await Promise.all(keys.map((key) => io.cluster('KEYSLOT', key))))
        .size,
    ).toBe(1);
    await io.del(...keys, `valve:{${id}}:s:named:r:C`);
  });
  it('shares global leases and pub/sub wakeups across client families', async () => {
    const ioSubscriber = io.duplicate();
    const nodeSubscriber = node.duplicate();
    await nodeSubscriber.connect();
    const a = redisStore({ client: io, subscriber: ioSubscriber });
    const b = redisStore({ client: node, subscriber: nodeSubscriber });
    const id = `cluster-global-${crypto.randomUUID()}`;
    const first = createValve({
      id,
      store: a,
      concurrency: { limit: 1, scope: 'global', leaseTtl: 300 },
    });
    const second = createValve({
      id,
      store: b,
      concurrency: { limit: 1, scope: 'global', leaseTtl: 300 },
    });
    let running = 0;
    let peak = 0;
    const work = async () => {
      peak = Math.max(peak, ++running);
      await new Promise((resolve) => setTimeout(resolve, 110));
      running--;
    };
    try {
      await Promise.all([first.run(work), second.run(work), first.run(work)]);
      expect(peak).toBe(1);
      await first.pause(10000);
      let finished = false;
      const queued = second.run(() => {
        finished = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(finished).toBe(false);
      await first.resume();
      await Promise.race([
        queued,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('cluster pub/sub failed')), 1000),
        ),
      ]);
      expect(finished).toBe(true);
    } finally {
      await first.close();
      await second.close();
      await a.close();
      await b.close();
      await ioSubscriber.quit();
      await nodeSubscriber.quit();
    }
  });
});
