// Resolve short shared-store measurements with longer same-runner paired controls.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const [baseline, output] = process.argv.slice(2);
if (!baseline || !output)
  throw new Error('Usage: paired-footprint-controls.mjs BASE_REPO OUTPUT_DIR');
if (!process.env.REDIS_URL || !process.env.VALKEY_URL)
  throw new Error('Both REDIS_URL and VALKEY_URL are required');
const roots = { baseline: resolve(baseline), current: process.cwd() };
const directory = resolve(output);
mkdirSync(directory, { recursive: true });
const scenarios = [
  'memory/concurrency',
  'memory/gcra',
  'memory/fixed-window',
  'memory/multi-rule',
  ...['redis', 'valkey'].flatMap((server) =>
    ['ioredis', 'node-redis'].flatMap((client) =>
      ['gcra', 'fixed-window', 'multi-rule'].map(
        (rule) => `${server}/${client}/${rule}`,
      ),
    ),
  ),
];
const samples = { baseline: [], current: [] };
for (let pair = 0; pair < 3; pair++) {
  for (const variant of pair % 2
    ? ['current', 'baseline']
    : ['baseline', 'current']) {
    const path = join(directory, `control-${pair}-${variant}.json`);
    const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: roots[variant],
      encoding: 'utf8',
    });
    if (revision.error || revision.status !== 0)
      throw revision.error ?? new Error(revision.stderr);
    console.log(`Pair ${pair + 1}: ${variant}`);
    const result = spawnSync('pnpm', ['exec', 'tsx', 'bench/compare.ts'], {
      cwd: join(roots[variant], 'packages/valve'),
      stdio: 'inherit',
      env: {
        ...process.env,
        VALVE_BENCH_OUT: path,
        VALVE_BENCH_REVISION: revision.stdout.trim(),
        VALVE_BENCH_JOBS: '50000',
        VALVE_BENCH_SHARED_JOBS: '20000',
        VALVE_BENCH_REPEATS: '10',
        VALVE_BENCH_SKIP_BOTTLENECK: '1',
        VALVE_BENCH_SCENARIOS: scenarios.join(','),
      },
    });
    if (result.error || result.status !== 0)
      throw result.error ?? new Error(`${variant} exited ${result.status}`);
    samples[variant].push(JSON.parse(readFileSync(path, 'utf8')));
  }
}
const median = (values) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const rows = [];
for (const row of samples.baseline[0].rows) {
  const times = {};
  for (const variant of ['baseline', 'current']) {
    times[variant] = samples[variant].flatMap((sample) => {
      const match = sample.rows.find(
        (item) =>
          item.scenario === row.scenario && item.library === row.library,
      );
      if (
        !match ||
        match.jobs !== row.jobs ||
        match.elapsedMs.length !== 10 ||
        !match.elapsedMs.every((ms) => Number.isFinite(ms) && ms > 0)
      )
        throw new Error('Controls must contain identical, finite workloads');
      return match.elapsedMs;
    });
  }
  const baselineMs = median(times.baseline);
  const currentMs = median(times.current);
  const throughputChangePercent = (baselineMs / currentMs - 1) * 100;
  rows.push({
    scenario: row.scenario,
    library: row.library,
    jobs: row.jobs,
    baselineMs,
    currentMs,
    throughputChangePercent,
  });
  if (throughputChangePercent < -15) process.exitCode = 1;
}
const summary = {
  node: process.version,
  protocol:
    'Three alternating pairs; ten rounds after warmup per variant; pooled medians; all samples retained; 15% regression gate',
  rows,
};
writeFileSync(
  join(directory, 'summary.json'),
  JSON.stringify(summary, null, 2) + '\n',
);
console.log(JSON.stringify(summary, null, 2));
