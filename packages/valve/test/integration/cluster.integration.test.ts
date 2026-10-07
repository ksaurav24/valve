// Both client families route one valve's hash-tagged keys to one cluster slot.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Cluster } from 'ioredis5';
import { createCluster } from 'redis5';
import { redisStore } from '../../src/redis/index.js';
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
});
