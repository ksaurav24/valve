// Saturated pacing with one or eight valves, optional Redis, and injected RTT.
import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { Redis } from 'ioredis5';
import { redisStore } from '../src/redis/index.js';
import type { Store } from '../src/index.js';

const { createValve, memoryStore }: typeof import('../src/index.js') =
  await import(process.env.VALVE_BENCH_LIBRARY ?? '../src/index.js');
const jobs = Number(process.env.VALVE_BENCH_JOBS ?? 200);
const repeats = Number(process.env.VALVE_BENCH_REPEATS ?? 5);
for (const [name, value] of Object.entries({ jobs, repeats }))
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
  );
};
const rows = [];
const client = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, { lazyConnect: true })
  : undefined;

try {
  await client?.connect();
  for (const backend of client ? ['memory', 'redis'] : ['memory']) {
    for (const workers of [1, 8]) {
      for (const rttMs of backend === 'redis' ? [0, 5, 25] : [0]) {
        const samples = [];
        for (let round = -1; round < repeats; round++) {
          let commands = 0;
          let acquires = 0;
          let denied = 0;
          const store =
            backend === 'memory'
              ? memoryStore()
              : redisStore({
                  adapter: {
                    evalsha: (sha, keys, args) => {
                      commands++;
                      return client!.evalsha(
                        sha,
                        keys.length,
                        ...keys,
                        ...args,
                      );
                    },
                    eval: (script, keys, args) => {
                      commands++;
                      return client!.eval(
                        script,
                        keys.length,
                        ...keys,
                        ...args,
                      );
                    },
                  },
                });
          const record = (result: Awaited<ReturnType<Store['acquire']>>) => {
            acquires++;
            if (!result.granted) denied++;
            return result;
          };
          const measured: Store = {
            ...store,
            acquire: async (request) => {
              // Inject latency around the actual server call, not its clock.
              if (rttMs) await sleep(Math.floor(rttMs / 2));
              const result = await store.acquire(request);
              if (rttMs) await sleep(Math.ceil(rttMs / 2));
              return record(result);
            },
            ...(store.acquireSync
              ? {
                  acquireSync: (request) => record(store.acquireSync!(request)),
                }
              : {}),
          };
          const id = `paced-${crypto.randomUUID()}`;
          const valves = Array.from({ length: workers }, () =>
            createValve({
              id,
              rate: { limit: 100, interval: 1000 },
              concurrency: 16,
              store: measured,
            }),
          );
          const starts: number[] = [];
          const waits: number[] = [];
          const workerLastStartMs = Array<number>(workers).fill(0);
          const n = round < 0 ? Math.min(jobs, 32) : jobs;
          const initialCpu = process.cpuUsage();
          const began = performance.now();
          try {
            await Promise.all(
              Array.from({ length: n }, (_, i) => {
                const worker = i % workers;
                const queued = performance.now();
                return valves[worker]!.run(async () => {
                  const now = performance.now();
                  starts.push(now);
                  waits.push(now - queued);
                  workerLastStartMs[worker] = now - began;
                });
              }),
            );
            const elapsedMs = performance.now() - began;
            const cpu = process.cpuUsage(initialCpu);
            const gaps = starts.slice(1).map((time, i) => time - starts[i]!);
            const sample = {
              elapsedMs,
              throughput: (n / elapsedMs) * 1000,
              p99WaitMs: percentile(waits, 0.99),
              p99SpacingOvershootMs: percentile(
                gaps.map((gap) => Math.max(0, gap - 10)),
                0.99,
              ),
              p99IdealDelayMs: percentile(
                starts.map((time, i) => time - starts[0]! - i * 10),
                0.99,
              ),
              minCallbackGapMs: gaps.length ? Math.min(...gaps) : 0,
              cpuMs: (cpu.user + cpu.system) / 1000,
              acquires,
              denied,
              commands,
              workerLastStartMs,
            };
            if (round >= 0) samples.push(sample);
          } finally {
            await Promise.all(valves.map((valve) => valve.close()));
            await store.close();
          }
        }
        const row = {
          backend,
          workers,
          injectedRttMs: rttMs,
          jobs,
          throughput:
            (jobs /
              percentile(
                samples.map((s) => s.elapsedMs),
                0.5,
              )) *
            1000,
          samples,
        };
        rows.push(row);
        console.log(JSON.stringify(row));
      }
    }
  }
} finally {
  await client?.quit();
}

if (process.env.VALVE_BENCH_OUT)
  writeFileSync(
    process.env.VALVE_BENCH_OUT,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        node: process.version,
        cpu: cpus()[0]?.model,
        library: process.env.VALVE_BENCH_LIBRARY ?? '../src/index.js',
        revision: process.env.VALVE_BENCH_REVISION,
        repeats,
        rows,
      },
      null,
      2,
    ) + '\n',
  );
