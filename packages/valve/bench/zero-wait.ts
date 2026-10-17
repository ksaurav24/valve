// maxWait 0 admission parity across sync, async, and network stores (issue #92).
// Every job should reach the store unless a denial, pause, or full local
// concurrency rules it out, so each store should report the same outcomes.
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { Redis } from 'ioredis5';
import type { Store } from '../src/index.js';
const { createValve, memoryStore }: typeof import('../src/index.js') =
  await import(process.env.VALVE_BENCH_LIBRARY ?? '../src/index.js');
const { redisStore }: typeof import('../src/redis/index.js') = await import(
  process.env.VALVE_BENCH_REDIS_LIBRARY ?? '../src/redis/index.js'
);
const jobs = Number(process.env.VALVE_BENCH_JOBS ?? 512);
const reps = Number(process.env.VALVE_BENCH_REPS ?? 3);
const urls = Object.entries({
  redis: process.env.REDIS_URL,
  valkey: process.env.VALKEY_URL,
}).filter((entry): entry is [string, string] => !!entry[1]);
const kinds = ['memory', 'memory-async', ...urls.map(([kind]) => kind)];
const policies = {
  // No rate denials: every job should run.
  free: { limit: 1e9, interval: 1000, burst: 1e9 },
  // One shared budget: grants across all workers must equal the limit.
  limited: {
    limit: 256,
    interval: '24h',
    algorithm: 'fixed-window',
  },
  // Half the jobs share one identity, which admits once.
  scoped: [{ name: 'r', scope: 'recipient', limit: 1, interval: '24h' }],
} as const;
const clients = new Map(urls.map(([kind, url]) => [kind, new Redis(url)]));
const rows = [];
try {
  for (const [policy, rate] of Object.entries(policies))
    for (const kind of kinds)
      for (const batch of [1, 32, 128])
        for (const workers of [1, 4])
          for (let rep = 0; rep < reps; rep++) {
            const id = `zero-wait-${policy}-${process.pid}-${performance.now()}`;
            const client = clients.get(kind);
            // Workers model separate processes: one store each, shared state.
            const shared = client ? undefined : memoryStore();
            let calls = 0;
            let sent = 0;
            const valves = Array.from({ length: workers }, () => {
              const base = client
                ? redisStore({ client, prefix: 'zero-wait-bench' })
                : shared!;
              const store: Store = {
                ...base,
                acquire: (request) => {
                  calls++;
                  sent += request.costs.length;
                  return base.acquire(request);
                },
                acquireScoped: (request) => {
                  calls++;
                  sent += request.jobs.length;
                  return base.acquireScoped!(request);
                },
              };
              delete store.acquireSync;
              delete store.acquireScopedSync;
              if (kind === 'memory') {
                store.acquireSync = (request) => {
                  calls++;
                  sent += request.costs.length;
                  return base.acquireSync!(request);
                };
                store.acquireScopedSync = (request) => {
                  calls++;
                  sent += request.jobs.length;
                  return base.acquireScopedSync!(request);
                };
              }
              return createValve({
                id,
                rate: rate as never,
                concurrency: 64,
                batch,
                store,
              });
            });
            const outcomes: Record<string, number> = {};
            const start = performance.now();
            await Promise.all(
              valves.flatMap((valve) =>
                Array.from({ length: jobs }, (_, i) =>
                  valve
                    .run(() => undefined, {
                      maxWait: 0,
                      ...(policy === 'scoped'
                        ? { scopes: { recipient: i % 2 ? `c${i}` : 'hot' } }
                        : {}),
                    })
                    .then(
                      () => 'ok',
                      (error: { code: string }) => error.code,
                    )
                    .then((key) => (outcomes[key] = (outcomes[key] ?? 0) + 1)),
                ),
              ),
            );
            const ms = performance.now() - start;
            await Promise.all(valves.map((valve) => valve.close()));
            await shared?.close();
            const total = jobs * workers;
            const row = {
              policy,
              store: kind,
              batch,
              workers,
              rep,
              jobs: total,
              storeCalls: calls,
              jobsSent: sent,
              ok: outcomes.ok ?? 0,
              rejected: total - (outcomes.ok ?? 0),
              outcomes,
              ms,
              settledPerSecond: Math.round((total / ms) * 1000),
              usPerJob: (ms * 1000) / total,
            };
            rows.push(row);
            console.log(
              `${policy} ${kind} batch=${batch} workers=${workers} rep=${rep}: sent ${sent}/${total} in ${calls} calls, ok ${row.ok}, ${ms.toFixed(1)}ms (${row.usPerJob.toFixed(2)}us/job)`,
            );
          }
} finally {
  for (const client of clients.values()) {
    const keys = await client.keys('zero-wait-bench*');
    if (keys.length) await client.del(...keys);
    await client.quit();
  }
}
if (process.env.VALVE_BENCH_OUT)
  writeFileSync(
    process.env.VALVE_BENCH_OUT,
    JSON.stringify({ jobs, reps, node: process.version, rows }, null, 2),
  );
