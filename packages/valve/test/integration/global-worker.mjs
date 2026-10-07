// Independent process exercising leased concurrency and crash recovery.
import { Redis } from 'ioredis5';
import { createValve } from '../../dist/index.js';
import { redisStore } from '../../dist/redis/index.js';
const [url, id, mode = 'jobs'] = process.argv.slice(2);
const client = new Redis(url);
const subscriber = client.duplicate();
const store = redisStore({ client, subscriber });
const api = createValve({
  id,
  concurrency: {
    limit: mode === 'hold' ? 1 : 4,
    scope: 'global',
    leaseTtl: mode === 'hold' ? 300 : 1000,
  },
  store,
});
if (mode === 'hold') {
  await api.run(async () => {
    process.send?.({ started: true });
    await new Promise(() => {});
  });
} else {
  await Promise.all(
    Array.from({ length: 30 }, () =>
      api.run(async () => {
        await client.eval(
          "local n=redis.call('INCR',KEYS[1]); local peak=tonumber(redis.call('GET',KEYS[2])) or 0; if n>peak then redis.call('SET',KEYS[2],n) end; return n",
          2,
          `bench:{${id}}:running`,
          `bench:{${id}}:peak`,
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        await client.decr(`bench:{${id}}:running`);
      }),
    ),
  );
  await api.close();
  await store.close();
  await subscriber.quit();
  await client.quit();
}
