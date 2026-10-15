// Controlled independent owner; SIGKILL and Atomics.wait never affect the runner.
import { writeFileSync } from 'node:fs';
import { Redis } from 'ioredis5';
import { createValve } from '../../dist/index.js';
import { redisStore } from '../../dist/redis/index.js';

const [url, prefix, id, ttl, effectPath] = process.argv.slice(2);
const leaseTtl = Number(ttl);
const client = new Redis(url);
const store = redisStore({ client, prefix });
let token;
const api = createValve({
  id,
  store: {
    ...store,
    async acquire(request) {
      const result = await store.acquire(request);
      if (result.granted) token = result.leases[0];
      return result;
    },
  },
  concurrency: { limit: 1, scope: 'global', leaseTtl },
  maxWait: 10000,
});
let finish;
let jobSignal;
const send = (message) => process.send?.(message);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function work(mode) {
  const job = () =>
    api.run(async ({ signal }) => {
      jobSignal = signal;
      signal.addEventListener(
        'abort',
        () => send({ type: 'abort', code: signal.reason?.code }),
        { once: true },
      );
      // Timestamp admission on Redis's clock, and count live ownership there.
      const [admittedAt, owners, peak] = await client.eval(
        `local t=redis.call('TIME'); local now=tonumber(t[1])*1000+tonumber(t[2])/1000
       local owners=redis.call('ZCOUNT',KEYS[1],now,'+inf')
       local n=redis.call('INCR',KEYS[2]); local peak=tonumber(redis.call('GET',KEYS[3])) or 0
       if n>peak then peak=n; redis.call('SET',KEYS[3],peak) end
       local score=tonumber(redis.call('ZSCORE',KEYS[1],ARGV[1]))
       return {tostring(score-tonumber(ARGV[2])),owners,peak}`,
        3,
        `${prefix}:{${id}}:leases`,
        `${prefix}:{${id}}:running`,
        `${prefix}:{${id}}:peak`,
        token,
        String(leaseTtl),
      );
      send({ type: 'started', admittedAt: Number(admittedAt), owners, peak });
      if (mode === 'jobs') await sleep(leaseTtl * 2);
      else
        await new Promise((resolve) => {
          finish = resolve;
        });
      await client.decr(`${prefix}:{${id}}:running`);
      return 42;
    });
  let code;
  let ok = true;
  try {
    if (mode === 'jobs') await Promise.all([job(), job()]);
    else await job();
  } catch (error) {
    ok = false;
    code = error.code;
  }
  send({
    type: 'result',
    ok,
    code,
    aborted: jobSignal?.aborted,
    reason: jobSignal?.reason?.code,
  });
  await api.close();
  await store.close();
  client.disconnect();
  process.disconnect();
}

process.on('message', (message) => {
  if (message.type === 'run') {
    void work(message.mode).catch((error) => {
      console.error(error);
      process.exit(1);
    });
    send({ type: 'queued' });
  } else if (message.type === 'finish') finish?.();
  else if (message.type === 'stall') {
    // Flush the IPC acknowledgement before blocking. On resume, the synchronous
    // effect runs before renewal timers or AbortSignal listeners can execute.
    process.send({ type: 'blocking' }, () => {
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        leaseTtl * 4,
      );
      writeFileSync(effectPath, 'effect after expired ownership');
      send({ type: 'effect', aborted: jobSignal.aborted });
      finish();
    });
  }
});
await client.ping();
send({ type: 'ready' });
