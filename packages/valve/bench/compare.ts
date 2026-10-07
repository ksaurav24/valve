// Comparable workloads, warmups, repeated samples, and raw JSON for review.
import { performance } from 'node:perf_hooks';
import { cpus, platform, arch, totalmem } from 'node:os';
import { writeFileSync, readFileSync } from 'node:fs';
import PQueue from 'p-queue';
import pLimit from 'p-limit';
import Bottleneck from 'bottleneck';
import { Redis } from 'ioredis5';
import { createClient } from 'redis5';
import { redisStore } from '../src/redis/index.js';
import type { RateRule, ValveOptions } from '../src/index.js';
const { createValve }: typeof import('../src/index.js') = await import(
  process.env.VALVE_BENCH_LIBRARY ?? '../src/index.js'
);
const repeats = Number(process.env.VALVE_BENCH_REPEATS ?? 5);
const count = Number(process.env.VALVE_BENCH_JOBS ?? 10000);
const sharedCount = process.env.VALVE_BENCH_SHARED_JOBS;
const scenarios = process.env.VALVE_BENCH_SCENARIOS?.split(',');
const redisUrl = process.env.REDIS_URL;
const valkeyUrl = process.env.VALKEY_URL;
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
type Scheduler = {
  run: (job: () => Promise<void>, i: number) => Promise<unknown>;
  close: () => Promise<unknown>;
};
type Factory = () => Promise<Scheduler>;
const rows: {
  scenario: string;
  library: string;
  jobs: number;
  elapsedMs: number[];
  throughput: number;
  p50WaitMs: number;
  p99WaitMs: number;
  p99ServiceMs: number;
  maxRunning: number;
  cpuMs: number;
  heapDeltaBytes: number;
  acquiresPerJob?: number;
  storeCallsPerJob?: number;
  p99SpacingOvershootMs?: number;
  p99IdealDelayMs?: number;
  minGapMs?: number;
}[] = [];
const cleanup: (() => Promise<void>)[] = [];
const metrics = new Map<string, () => { acquires: number; calls: number }>();
const factories: {
  scenario: string;
  library: string;
  count: number;
  workMs: number;
  factory: Factory;
}[] = [];
function valveFactory(
  options: Omit<ValveOptions, 'id'>,
  weighted = false,
  priority = false,
): Factory {
  return async () => {
    const api = createValve({ id: `bench-${crypto.randomUUID()}`, ...options });
    return {
      run: (job, i) =>
        api.run(job, {
          cost: weighted ? 1 + (i % 3) : 1,
          priority: priority ? i % 10 : 0,
        }),
      close: () => api.close(),
    };
  };
}
const huge = 1000000000;
const gcra: RateRule = { limit: huge, interval: 1000, burst: huge };
const fixed: RateRule = {
  limit: huge,
  interval: 1000,
  algorithm: 'fixed-window',
};
for (const [name, rate, weighted, priority] of [
  ['concurrency', undefined, false, false],
  ['gcra', gcra, false, false],
  ['fixed-window', fixed, false, false],
  ['multi-rule', [gcra, fixed], false, false],
  ['weighted', [gcra, fixed], true, false],
  ['priority', gcra, false, true],
] as const)
  factories.push({
    scenario: `memory/${name}`,
    library: 'valve',
    count,
    workMs: 0,
    factory: valveFactory(
      { concurrency: 16, ...(rate ? { rate } : {}) },
      weighted,
      priority,
    ),
  });
factories.push({
  scenario: 'memory/global-16',
  library: 'valve',
  count,
  workMs: 0,
  factory: valveFactory({ concurrency: { limit: 16, scope: 'global' } }),
});
const simpleFactories: [string, Factory][] = [
  [
    'p-limit',
    async () => {
      const limiter = pLimit(16);
      return { run: (job) => limiter(job), close: async () => {} };
    },
  ],
  [
    'p-queue',
    async () => {
      const queue = new PQueue({ concurrency: 16 });
      return { run: (job) => queue.add(job), close: async () => {} };
    },
  ],
  [
    'Bottleneck',
    async () => {
      const limiter = new Bottleneck({ maxConcurrent: 16 });
      return {
        run: (job) => limiter.schedule(job),
        close: async () => {
          await limiter.stop();
          await limiter.disconnect();
        },
      };
    },
  ],
];
for (const [library, factory] of simpleFactories)
  factories.push({
    scenario: 'memory/concurrency',
    library,
    count,
    workMs: 0,
    factory,
  });
for (const [library, factory] of [
  ['valve', valveFactory({ concurrency: 16 })],
  ...simpleFactories,
] as [string, Factory][])
  factories.push({
    scenario: 'async-5ms/concurrency',
    library,
    count: 512,
    workMs: 5,
    factory,
  });
factories.push({
  scenario: 'paced-100/s',
  library: 'valve',
  count: 200,
  workMs: 0,
  factory: valveFactory({
    rate: { limit: 100, interval: 1000 },
    concurrency: 16,
  }),
});
factories.push({
  scenario: 'paced-100/s',
  library: 'Bottleneck',
  count: 200,
  workMs: 0,
  factory: async () => {
    const limiter = new Bottleneck({ maxConcurrent: 16, minTime: 10 });
    return {
      run: (job) => limiter.schedule(job),
      close: async () => {
        await limiter.stop();
        await limiter.disconnect();
      },
    };
  },
});
for (const [server, url] of [
  ['redis', redisUrl],
  ['valkey', valkeyUrl],
] as const)
  if (url) {
    for (const family of ['ioredis', 'node-redis'] as const) {
      const client =
        family === 'ioredis' ? new Redis(url) : createClient({ url });
      if (family === 'node-redis')
        await (client as ReturnType<typeof createClient>).connect();
      const subscriber = client.duplicate();
      if (family === 'node-redis')
        await (subscriber as ReturnType<typeof createClient>).connect();
      const store = redisStore({ client, subscriber });
      let acquires = 0;
      let calls = 0;
      const measured = {
        ...store,
        acquire: (request: Parameters<typeof store.acquire>[0]) => {
          acquires++;
          calls++;
          return store.acquire(request);
        },
      };
      for (const [kind, rate] of [
        ['gcra', gcra],
        ['fixed-window', fixed],
        ['multi-rule', [gcra, fixed]],
        ['weighted', [gcra, fixed]],
        ['priority', gcra],
      ] as const)
        factories.push({
          scenario: `${server}/${family}/${kind}`,
          library: 'valve',
          count: Number(sharedCount ?? 2000),
          workMs: 0,
          factory: valveFactory(
            { rate, store: measured },
            kind === 'weighted',
            kind === 'priority',
          ),
        });
      factories.push({
        scenario: `${server}/${family}/global-16`,
        library: 'valve',
        count: Number(sharedCount ?? 1000),
        workMs: 0,
        factory: valveFactory({
          rate: gcra,
          concurrency: { limit: 16, scope: 'global' },
          store: measured,
        }),
      });
      if (store.release)
        measured.release = (id, tokens) => {
          calls++;
          return store.release!(id, tokens);
        };
      if (store.renew)
        measured.renew = (id, tokens, ttlMs) => {
          calls++;
          return store.renew!(id, tokens, ttlMs);
        };
      // Connections are closed only after their scenarios have run.
      cleanup.push(async () => {
        await store.close();
        await subscriber.quit();
        await client.quit();
      });
      metrics.set(`${server}/${family}`, () => ({ acquires, calls }));
    }
    factories.push({
      scenario: `${server}/global-16`,
      library: 'Bottleneck',
      count: Number(sharedCount ?? 1000),
      workMs: 0,
      factory: async () => {
        const limiter = new Bottleneck({
          id: `bench-${crypto.randomUUID()}`,
          datastore: 'ioredis',
          Redis,
          maxConcurrent: 16,
          clientOptions: {
            host: new URL(url).hostname,
            port: Number(new URL(url).port),
          },
          clearDatastore: true,
        });
        await limiter.ready();
        return {
          run: (job) => limiter.schedule(job),
          close: async () => {
            await limiter.stop();
            await limiter.disconnect();
          },
        };
      },
    });
  }
function percentile(values: number[], p: number) {
  return (
    values.slice().sort((a, b) => a - b)[
      Math.min(values.length - 1, Math.floor(values.length * p))
    ] ?? 0
  );
}
async function measure(item: (typeof factories)[number]) {
  const elapsed: number[] = [];
  let waits: number[] = [],
    services: number[] = [],
    peak = 0,
    cpuTotal = 0,
    heapDelta = 0,
    acquires = 0,
    storeCalls = 0;
  let startTimes: number[] = [];
  for (let round = -1; round < repeats; round++) {
    const scheduler = await item.factory();
    const n = round < 0 ? Math.min(1000, item.count) : item.count;
    const w: number[] = [],
      s: number[] = [],
      starts: number[] = [];
    let running = 0,
      maximum = 0;
    const acquireMetric = [...metrics].find(([key]) =>
      item.scenario.startsWith(key),
    )?.[1];
    const initialAcquires = acquireMetric?.() ?? { acquires: 0, calls: 0 };
    const initialCpu = process.cpuUsage(),
      initialHeap = process.memoryUsage().heapUsed;
    const start = performance.now();
    await Promise.all(
      Array.from({ length: n }, (_, i) => {
        const enqueued = performance.now();
        return scheduler.run(async () => {
          const began = performance.now();
          starts.push(began);
          w.push(began - enqueued);
          maximum = Math.max(maximum, ++running);
          if (item.workMs) await sleep(item.workMs);
          running--;
          s.push(performance.now() - began);
        }, i);
      }),
    );
    const ms = performance.now() - start;
    const cpu = process.cpuUsage(initialCpu);
    await scheduler.close();
    if (round >= 0) {
      elapsed.push(ms);
      waits = w;
      startTimes = starts;
      services = s;
      peak = Math.max(peak, maximum);
      cpuTotal += (cpu.user + cpu.system) / 1000;
      heapDelta += process.memoryUsage().heapUsed - initialHeap;
      const measuredCalls = acquireMetric?.() ?? { acquires: 0, calls: 0 };
      acquires += measuredCalls.acquires - initialAcquires.acquires;
      storeCalls += measuredCalls.calls - initialAcquires.calls;
    }
  }
  const median = percentile(elapsed, 0.5);
  const row = {
    scenario: item.scenario,
    library: item.library,
    jobs: item.count,
    elapsedMs: elapsed,
    throughput: (item.count / median) * 1000,
    p50WaitMs: percentile(waits, 0.5),
    p99WaitMs: percentile(waits, 0.99),
    p99ServiceMs: percentile(services, 0.99),
    maxRunning: peak,
    cpuMs: cpuTotal / repeats,
    heapDeltaBytes: heapDelta / repeats,
    ...(acquires
      ? {
          acquiresPerJob: acquires / (item.count * repeats),
          storeCallsPerJob: storeCalls / (item.count * repeats),
        }
      : {}),
    ...(item.scenario === 'paced-100/s'
      ? {
          p99SpacingOvershootMs: percentile(
            startTimes
              .slice(1)
              .map((time, i) => Math.max(0, time - startTimes[i]! - 10)),
            0.99,
          ),
          p99IdealDelayMs: percentile(
            startTimes.map((time, i) => time - startTimes[0]! - i * 10),
            0.99,
          ),
          minGapMs: Math.min(
            ...startTimes.slice(1).map((time, i) => time - startTimes[i]!),
          ),
        }
      : {}),
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}
try {
  for (const item of factories)
    if (
      (!scenarios || scenarios.includes(item.scenario)) &&
      (!process.env.VALVE_BENCH_SKIP_BOTTLENECK ||
        item.library !== 'Bottleneck')
    )
      await measure(item);
} finally {
  await Promise.all(cleanup.map((close) => close()));
}
const versions = Object.fromEntries(
  ['bottleneck', 'p-limit', 'p-queue', 'ioredis5', 'redis5'].map((name) => [
    name,
    JSON.parse(
      readFileSync(
        new URL(`../node_modules/${name}/package.json`, import.meta.url),
        'utf8',
      ),
    ).version,
  ]),
);
const output = {
  date: new Date().toISOString(),
  node: process.version,
  platform: platform(),
  arch: arch(),
  cpu: cpus()[0]?.model,
  logicalCpus: cpus().length,
  totalMemory: totalmem(),
  repeats,
  library: process.env.VALVE_BENCH_LIBRARY ?? '../src/index.js',
  revision: process.env.VALVE_BENCH_REVISION,
  versions,
  notes: [
    'All jobs return promises; setup and warmup excluded.',
    'Latency percentiles describe last measured round; elapsed reports every round.',
    'Heap delta is GC-sensitive and is not peak memory.',
    'Paced workloads impose an application rate cap; fixed window is measured without quota exhaustion.',
    'Redis command families share one backend but use fresh budget ids per round.',
  ],
  rows,
};
writeFileSync(
  process.env.VALVE_BENCH_OUT ?? 'bench/comparison.json',
  JSON.stringify(output, null, 2) + '\n',
);
