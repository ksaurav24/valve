import { Redis } from 'ioredis5';
import { redisStore } from '../../dist/redis/index.js';
const client = new Redis(process.env.REDIS_URL, { lazyConnect: true });
const store = redisStore({ client, prefix: process.env.SCOPED_PREFIX });
try {
  await client.connect();
  const start = new Promise((resolve) => process.once('message', resolve));
  process.send('ready');
  await start;
  const result = await store.acquireScoped({
    id: process.env.SCOPED_ID,
    rules: [
      {
        key: 'fixed-window:86400000',
        algorithm: 'fixed-window',
        intervalMs: 86400000,
        limit: 10,
        burst: 1,
      },
      {
        name: 'r',
        key: 'named:r',
        scope: 'recipient',
        algorithm: 'gcra',
        intervalMs: 86400000,
        limit: 1,
        burst: 1,
      },
    ],
    jobs: Array.from({ length: 20 }, (_, i) => ({
      cost: 1,
      scopes: { recipient: String(i) },
    })),
  });
  process.send(result.grantedIndexes.map(String));
} finally {
  await client.quit();
}
