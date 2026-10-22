// Independent stale-seed worker: Redis, rather than these numbers, owns the limit.
import { Redis } from 'ioredis5';
import { redisStore } from '../../dist/redis/index.js';
const [url, prefix, id] = process.argv.slice(2);
const client = new Redis(url);
const store = redisStore({ client, prefix });
const result = await store.managed.acquire({
  id,
  rules: [
    {
      name: 'budget',
      key: 'named:budget',
      algorithm: 'fixed-window',
      limit: 16,
      burst: 1,
      intervalMs: 86400000,
    },
  ],
  costs: Array(8).fill(1),
});
process.send?.({ granted: result.granted });
await store.close();
await client.quit();
