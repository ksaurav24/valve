// Benchmark-only source instrumentation; no hooks are shipped in the package.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const { build } = require('esbuild');
const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
    0
  );
};
const distribution = (values) => ({
  p50: percentile(values, 0.5),
  p99: percentile(values, 0.99),
  max: Math.max(0, ...values),
});

if (process.argv[2] === '--worker') {
  const { library, jobs, responseMs, trace } = JSON.parse(process.argv[3]);
  const { createValve, memoryStore, setTrace } = await import(
    pathToFileURL(library).href
  );
  const events = [];
  const record = (type, data) =>
    events.push({ type, time: performance.now(), wall: Date.now(), ...data });
  if (trace) setTrace(record);
  const store = memoryStore();
  let acquisitions = 0;
  const acquireSync = store.acquireSync;
  store.acquireSync = (request) => {
    acquisitions++;
    return acquireSync(request);
  };
  if (responseMs) {
    delete store.acquireSync;
    store.acquire = async (request) => {
      acquisitions++;
      const result = acquireSync(request);
      await new Promise((resolve) => setTimeout(resolve, responseMs));
      return result;
    };
  }
  const valve = createValve({
    id: 'drift',
    concurrency: 16,
    rate: { limit: 100, interval: 1000 },
    store,
  });
  const warmup = createValve({
    id: 'warmup',
    concurrency: 16,
    rate: { limit: 100, interval: 1000 },
    store,
  });
  await Promise.all(
    Array.from({ length: 32 }, () => warmup.run(() => undefined)),
  );
  await warmup.close();
  events.length = 0;
  acquisitions = 0;
  const starts = [];
  const waits = [];
  const services = [];
  const lag = monitorEventLoopDelay({ resolution: 1 });
  const collections = [];
  const observer = new PerformanceObserver((list) =>
    collections.push(...list.getEntries().map((entry) => entry.duration)),
  );
  observer.observe({ entryTypes: ['gc'] });
  lag.enable();
  const cpuStart = process.cpuUsage();
  const began = performance.now();
  await Promise.all(
    Array.from({ length: jobs }, () => {
      const queued = performance.now();
      return valve.run(() => {
        const started = performance.now();
        starts.push(started);
        waits.push(started - queued);
        services.push(performance.now() - started);
      });
    }),
  );
  const elapsedMs = performance.now() - began;
  const cpu = process.cpuUsage(cpuStart);
  lag.disable();
  await valve.close();
  await store.close();
  await new Promise((resolve) => setImmediate(resolve));
  observer.disconnect();
  const admissions = events.filter(
    (event) => event.type === 'admission' && event.granted,
  );
  const gaps = starts.slice(1).map((time, i) => time - starts[i]);
  const admissionGaps = admissions
    .slice(1)
    .map((event, i) => event.now - admissions[i].now);
  const wakes = [];
  const dispatch = [];
  let armed;
  let granted;
  for (const event of events) {
    if (event.type === 'arm') armed = event;
    if (event.type === 'wake' && armed)
      wakes.push(event.time - armed.time - armed.delay);
    if (event.type === 'admission' && event.granted) granted = event;
    if (event.type === 'dispatch' && granted)
      dispatch.push(event.time - granted.time);
  }
  const memory = process.resourceUsage();
  console.log(
    JSON.stringify({
      node: process.version,
      jobs,
      responseMs,
      trace,
      performanceTimeOrigin: performance.timeOrigin,
      elapsedMs,
      throughput: (jobs * 1000) / elapsedMs,
      queueWaitMs: distribution(waits),
      serviceMs: distribution(services),
      spacingOvershootMs: distribution(
        gaps.map((gap) => Math.max(0, gap - 10)),
      ),
      idealSequenceDelayMs: distribution(
        starts.map((time, i) => time - starts[0] - i * 10),
      ),
      minCallbackGapMs: Math.min(...gaps),
      minStoreGapMs: admissionGaps.length ? Math.min(...admissionGaps) : null,
      timerDeliveryOvershootMs: distribution(wakes),
      timerRoundingMs: distribution(
        events
          .filter((event) => event.type === 'arm')
          .map((event) => event.roundingMs),
      ),
      dispatchMs: distribution(dispatch),
      cpuMs: (cpu.user + cpu.system) / 1000,
      peakRssKiB: memory.maxRSS,
      heapUsedAfterBytes: process.memoryUsage().heapUsed,
      gc: {
        count: collections.length,
        durationMs: collections.reduce((a, b) => a + b, 0),
      },
      eventLoopDelayMs: {
        p50: lag.percentile(50) / 1e6,
        p99: lag.percentile(99) / 1e6,
        max: lag.max / 1e6,
      },
      acquisitions,
      storeCommands: 0,
      events,
    }),
  );
} else {
  const baseline =
    process.env.VALVE_DRIFT_BASELINE ??
    '360621096a5b9a05b2886a17748d539cd6436cf5';
  const repeats = Number(process.env.VALVE_DRIFT_REPEATS ?? 3);
  const counts = (process.env.VALVE_DRIFT_JOBS ?? '200,2000')
    .split(',')
    .map(Number);
  const responses = (process.env.VALVE_DRIFT_RESPONSE_MS ?? '0,5')
    .split(',')
    .map(Number);
  for (const value of [repeats, ...counts])
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error('Counts must be positive integers');
  for (const value of responses)
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error('Response delays must be nonnegative integers');
  const trace = process.env.VALVE_DRIFT_TRACE !== '0';
  const scratch = mkdtempSync(join(tmpdir(), 'valve-drift-'));
  const variants = ['baseline', 'current'];
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const diff = execFileSync('git', ['diff', '--', 'packages/valve/src'], {
    cwd: root,
    encoding: 'utf8',
  });
  const replace = (source, needle, replacement) => {
    if (
      !source.includes(needle) ||
      source.indexOf(needle) !== source.lastIndexOf(needle)
    )
      throw new Error(`Instrumentation anchor changed: ${needle}`);
    return source.replace(needle, replacement);
  };
  try {
    for (const variant of variants) {
      await build({
        entryPoints: [join(root, 'packages/valve/src/index.ts')],
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node20',
        outfile: join(scratch, `${variant}.mjs`),
        banner: {
          js: `let __trace = () => {};
function __timerDelay(at) {
  const wallAtArm = Date.now();
  const remaining = at - wallAtArm;
  const delay = Math.min(2147483647, Math.max(1, Math.ceil(remaining)));
  __trace('arm', { at, delay, wallAtArm, roundingMs: delay - remaining });
  return delay;
}`,
        },
        footer: {
          js: 'export function setTrace(listener) { __trace = listener; }',
        },
        plugins: [
          {
            name: 'benchmark-trace',
            setup(context) {
              context.onLoad({ filter: /\/src\/.*\.ts$/ }, ({ path }) => {
                const relative = path.slice(root.length);
                let source =
                  variant === 'baseline'
                    ? execFileSync('git', ['show', `${baseline}:${relative}`], {
                        cwd: root,
                        encoding: 'utf8',
                      })
                    : readFileSync(path, 'utf8');
                if (trace && path.endsWith('/valve.ts')) {
                  source = replace(
                    source,
                    'Math.min(2147483647, Math.max(1, Math.ceil(at - Date.now())))',
                    '__timerDelay(at)',
                  );
                  source = replace(
                    source,
                    '        wake = undefined;',
                    "        __trace('wake', { at: wakeAt }); wake = undefined;",
                  );
                  source = replace(
                    source,
                    'result = job.fn(',
                    "__trace('dispatch', { seq: job.seq }); result = job.fn(",
                  );
                }
                if (trace && path.endsWith('/memory-store.ts'))
                  source = replace(
                    source,
                    'return returnResult ?? result;',
                    "__trace('admission', { now, granted: result.granted, retryAfterMs: result.retryAfterMs, eligibleAt: now + result.retryAfterMs }); return returnResult ?? result;",
                  );
                return {
                  contents: source,
                  loader: 'ts',
                  resolveDir: dirname(path),
                };
              });
            },
          },
        ],
      });
    }
    const samples = [];
    const run = (variant, jobs, responseMs) => {
      const config = {
        library: join(scratch, `${variant}.mjs`),
        jobs,
        responseMs,
        trace,
      };
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(import.meta.url), '--worker', JSON.stringify(config)],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      );
      if (result.status !== 0)
        throw new Error(result.stderr || `Worker exited ${result.status}`);
      return JSON.parse(result.stdout);
    };
    for (const jobs of counts)
      for (const responseMs of responses) {
        // Each isolated worker warms its implementation before starting timers.
        for (let round = 0; round < repeats; round++)
          for (const variant of round % 2
            ? [...variants].reverse()
            : variants) {
            const sample = {
              variant,
              round,
              ...run(variant, jobs, responseMs),
            };
            samples.push(sample);
            const { events, ...summary } = sample;
            console.log(
              JSON.stringify({ ...summary, traceEvents: events.length }),
            );
          }
      }
    const report = {
      measuredAt: new Date().toISOString(),
      baseline,
      head,
      sourceDiff: diff,
      host: {
        cpu: cpus()[0]?.model,
        cpus: cpus().length,
        platform: platform(),
        release: release(),
      },
      node: process.version,
      esbuild: require('esbuild/package.json').version,
      harnessSha256: createHash('sha256')
        .update(readFileSync(fileURLToPath(import.meta.url)))
        .digest('hex'),
      options: {
        concurrency: 16,
        rate: { limit: 100, interval: 1000, burst: 1, algorithm: 'gcra' },
      },
      repeats,
      warmupJobs: 32,
      trace,
      samples,
    };
    if (process.env.VALVE_DRIFT_OUT)
      writeFileSync(
        resolve(process.env.VALVE_DRIFT_OUT),
        JSON.stringify(report, null, 2) + '\n',
      );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
