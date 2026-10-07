// B3 store round trips per grant under backlog and light load.
import { Redis } from 'ioredis5';
import { createValve } from '../src/index.js';
import { redisStore } from '../src/redis/index.js';
const client = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
const store = redisStore({ client });
for (const [label, count, burst] of [
  ['backlog', 1000, 1000],
  ['light', 10, 1],
] as const) {
  let calls = 0;
  const measured = {
    ...store,
    acquire: (request: Parameters<typeof store.acquire>[0]) => {
      calls++;
      return store.acquire(request);
    },
  };
  const api = createValve({
    id: `bench-${label}-${Date.now()}`,
    rate: { limit: 1000, interval: 1000, burst },
    store: measured,
  });
  if (label === 'backlog')
    await Promise.all(
      Array.from({ length: count }, () => api.run(() => undefined)),
    );
  else
    for (let i = 0; i < count; i++) {
      await api.run(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  console.log(
    `${label}: ${calls} acquires / ${count} jobs = ${(calls / count).toFixed(4)} round trips per job`,
  );
  await api.close();
}
await client.quit();
