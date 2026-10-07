// Reproducible B1 throughput and B2 scheduling accuracy, with JSON output.
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import PQueue from 'p-queue';
import pLimit from 'p-limit';
import Bottleneck from 'bottleneck';
const { createValve }: typeof import('../src/index.js') = await import(
  process.env.VALVE_BENCH_LIBRARY ?? '../src/index.js'
);
const count = Number(process.env.VALVE_BENCH_JOBS ?? 100000);
const noop = () => undefined;
const results: Record<string, number> = {};
async function measure(name: string, fn: () => Promise<unknown>) {
  const start = performance.now();
  await fn();
  const ms = performance.now() - start;
  results[name] = ms;
  console.log(
    `${name}: ${ms.toFixed(2)}ms, ${Math.round((count / ms) * 1000)} jobs/s`,
  );
}
await measure('valve', async () => {
  const valve = createValve({
    id: 'bench',
    rate: { limit: count * 1000, interval: 1000, burst: count },
    concurrency: 16,
  });
  await Promise.all(Array.from({ length: count }, () => valve.run(noop)));
  await valve.close();
});
await measure('p-limit', async () => {
  const limit = pLimit(16);
  await Promise.all(Array.from({ length: count }, () => limit(noop)));
});
await measure('p-queue', async () => {
  const queue = new PQueue({ concurrency: 16 });
  await Promise.all(Array.from({ length: count }, () => queue.add(noop)));
});
if (!process.env.VALVE_BENCH_SKIP_BOTTLENECK)
  await measure('bottleneck', async () => {
    const limiter = new Bottleneck({ maxConcurrent: 16 });
    await Promise.all(
      Array.from({ length: count }, () =>
        limiter.schedule(() => Promise.resolve(undefined)),
      ),
    );
    await limiter.stop();
  });
const accuracyCount = Number(process.env.VALVE_BENCH_ACCURACY_JOBS ?? 2000);
const api = createValve({
  id: 'accuracy',
  rate: { limit: 100, interval: 1000 },
});
const times: number[] = [];
await Promise.all(
  Array.from({ length: accuracyCount }, () =>
    api.run(() => {
      times.push(performance.now());
    }),
  ),
);
await api.close();
// Measure per-start delay against the earliest time allowed after the previous start.
const delays = times
  .slice(1)
  .map((time, i) => Math.max(0, time - times[i]! - 10))
  .sort((a, b) => a - b);
results.p99DelayMs = delays[Math.floor(delays.length * 0.99)] ?? 0;
const idealDelays = times
  .map((time, i) => Math.max(0, time - times[0]! - i * 10))
  .sort((a, b) => a - b);
results.p99IdealDelayMs =
  idealDelays[Math.floor(idealDelays.length * 0.99)] ?? 0;
results.accumulatedDelayMs =
  (times.at(-1) ?? 0) - (times[0] ?? 0) - (accuracyCount - 1) * 10;
console.log(
  `p99 per-start delay: ${results.p99DelayMs.toFixed(3)}ms; accumulated delay: ${results.accumulatedDelayMs.toFixed(3)}ms`,
);
if (process.env.VALVE_BENCH_OUT)
  writeFileSync(
    process.env.VALVE_BENCH_OUT,
    JSON.stringify(
      { jobs: count, accuracyJobs: accuracyCount, results },
      null,
      2,
    ),
  );
