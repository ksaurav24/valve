// UC3: a rate limit response pauses another worker on the same Redis budget.
import assert from 'node:assert/strict';
import { Redis } from 'ioredis';
import { createValve } from 'valvejs';
import { redisStore } from 'valvejs/redis';
const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
const store = redisStore({ client: redis });
const id = `feedback:example-${Date.now()}`;
const a = createValve({ id, concurrency: 1, store });
const b = createValve({ id, concurrency: 1, store });
try {
  await a.pause(100);
  const start = Date.now();
  const value = await b.run(() => 'resumed');
  assert.equal(value, 'resumed');
  assert.ok(Date.now() - start >= 90);
  let calls = 0;
  const limited = a.wrapFetch(
    async () =>
      new Response('body', {
        status: ++calls === 1 ? 429 : 200,
        headers: { 'retry-after': '0.01' },
      }),
  );
  assert.equal((await limited()).status, 200);
  assert.equal(calls, 2);
  console.log('Shared pause and rate-limit retry passed.');
} finally {
  await a.close();
  await b.close();
  await redis.quit();
}
