// UC1: six worker instances share one Redis quota.
import assert from 'node:assert/strict';
import { Redis } from 'ioredis';
import { createValve } from 'valvejs';
import { redisStore } from 'valvejs/redis';
const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
const store = redisStore({ client: redis });
const id = `hubspot:example-${Date.now()}`;
const workers = Array.from({ length: 6 }, () =>
  createValve({ id, rate: { limit: 190, interval: '10s' }, store }),
);
try {
  const results = await Promise.all(
    workers.map((worker, index) => worker.run(() => index)),
  );
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5]);
  console.log('Six workers shared one Redis budget.');
} finally {
  await Promise.all(workers.map((worker) => worker.close()));
  await redis.quit();
}
