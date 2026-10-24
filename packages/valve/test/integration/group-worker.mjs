// Separate-process group worker: runs one maxWait 0 job per key and reports grants.
import { Redis } from 'ioredis5';
import { createValveGroup } from '../../dist/group/index.js';
import { redisStore } from '../../dist/redis/index.js';
const [url, prefix, id, ...keys] = process.argv.slice(2);
const client = new Redis(url);
const store = redisStore({ client, prefix });
const group = createValveGroup({
  id,
  store,
  resolve: () => ({
    rate: { name: 'key', limit: 1, interval: '1m', algorithm: 'fixed-window' },
    limits: 'managed',
  }),
});
const granted = {};
for (const key of keys)
  granted[key] = await group
    .run(key, () => true, { maxWait: 0 })
    .catch((error) => error.code);
process.send?.({ granted });
await group.close();
await store.close();
await client.quit();
