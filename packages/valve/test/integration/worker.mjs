// A real child process recording start times on the Redis server clock.
import { Redis } from 'ioredis5';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const ACQUIRE = readFileSync(
  new URL('../../src/redis/acquire.lua', import.meta.url),
  'utf8',
);
import { createValve } from '../../dist/index.js';
import { redisStore } from '../../dist/redis/index.js';
const [url, id, count, mode = 'bound'] = process.argv.slice(2);
const client = new Redis(url);
const instrumented = ACQUIRE.replace(
  'return {granted, math.max(0, retry), 0}',
  "for i=1,granted do redis.call('RPUSH', KEYS[1] .. ':grants', string.format('%.17g', now)) end\nreturn {granted, math.max(0, retry), 0}",
);
const instrumentedSha = createHash('sha1').update(instrumented).digest('hex');
const adapter = {
  evalsha: (sha, keys, args) =>
    client.evalsha(
      sha === acquireSha ? instrumentedSha : sha,
      keys.length,
      ...keys,
      ...args,
    ),
  eval: (script, keys, args) =>
    client.eval(
      script === ACQUIRE ? instrumented : script,
      keys.length,
      ...keys,
      ...args,
    ),
};
const acquireSha = createHash('sha1').update(ACQUIRE).digest('hex');
const api = createValve({
  id,
  rate: { limit: mode === 'pause' ? 100 : 1000, interval: '1s', burst: 32 },
  concurrency: 32,
  store: redisStore({ adapter }),
});
const record =
  "local t=redis.call('TIME'); local n=tonumber(t[1])*1000+tonumber(t[2])/1000; redis.call('RPUSH', KEYS[1], string.format('%.17g',n)); return 1";
process.send?.({ ready: true });
if (mode === 'pause')
  await new Promise((resolve) => process.once('message', resolve));
await Promise.all(
  Array.from({ length: Number(count) }, () =>
    api.run(() =>
      mode === 'pause'
        ? client.eval(record, 1, `valve-test:{${id}}:starts`)
        : undefined,
    ),
  ),
);
await api.close();
await client.quit();
