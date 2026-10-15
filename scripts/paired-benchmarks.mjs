// Retain every cold-run sample and gate medians of alternating same-runner pairs.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [baselineLibrary, baselineOut, currentOut] = process.argv.slice(2);
if (!baselineLibrary || !baselineOut || !currentOut)
  throw new Error(
    'Usage: paired-benchmarks.mjs BASE_LIBRARY BASE_OUT CURRENT_OUT',
  );
if (resolve(baselineOut) === resolve(currentOut))
  throw new Error('Baseline and current output paths must differ');
const scratch = mkdtempSync(join(tmpdir(), 'valve-ci-pairs-'));
const samples = { baseline: [], current: [] };
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
try {
  for (let pair = 0; pair < 3; pair++) {
    const order = pair % 2 ? ['current', 'baseline'] : ['baseline', 'current'];
    for (const variant of order) {
      const path = join(scratch, `${pair}-${variant}.json`);
      const library =
        variant === 'baseline'
          ? resolve(baselineLibrary)
          : resolve('packages/valve/dist/index.js');
      console.log(`Pair ${pair + 1}: ${variant}`);
      const result = spawnSync('pnpm', ['bench'], {
        stdio: 'inherit',
        env: {
          ...process.env,
          VALVE_BENCH_LIBRARY: library,
          VALVE_BENCH_SKIP_BOTTLENECK: '1',
          VALVE_BENCH_OUT: path,
        },
      });
      if (result.error || result.status !== 0)
        throw (
          result.error ??
          new Error(`${variant} benchmark exited ${result.status}`)
        );
      const sample = JSON.parse(readFileSync(path, 'utf8'));
      if (
        !sample.results ||
        !(sample.results.valve > 0) ||
        !Number.isSafeInteger(sample.jobs) ||
        sample.jobs < 1 ||
        !Number.isSafeInteger(sample.accuracyJobs) ||
        sample.accuracyJobs < 1 ||
        !['valve', 'p99DelayMs'].every(
          (key) =>
            Number.isFinite(sample.results[key]) && sample.results[key] >= 0,
        ) ||
        !Object.values(sample.results).every((value) => Number.isFinite(value))
      )
        throw new Error(`${variant} benchmark returned invalid measurements`);
      samples[variant].push({ pair, library, ...sample });
      console.log(JSON.stringify({ variant, pair, library, ...sample }));
    }
  }
  const first = samples.baseline[0];
  const keys = Object.keys(first.results).sort();
  for (const sample of [...samples.baseline, ...samples.current])
    if (
      sample.jobs !== first.jobs ||
      sample.accuracyJobs !== first.accuracyJobs ||
      JSON.stringify(Object.keys(sample.results).sort()) !==
        JSON.stringify(keys)
    )
      throw new Error(
        'Benchmark samples must use identical workloads and metrics',
      );
  for (const [variant, output] of [
    ['baseline', baselineOut],
    ['current', currentOut],
  ]) {
    const report = {
      node: process.version,
      protocol:
        'Three alternating cold-run pairs; no samples discarded; original 15% gate unchanged.',
      jobs: first.jobs,
      accuracyJobs: first.accuracyJobs,
      results: Object.fromEntries(
        keys.map((key) => [
          key,
          median(samples[variant].map((sample) => sample.results[key])),
        ]),
      ),
      samples: samples[variant],
    };
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    // CI logs retain the complete samples as well as the files used by the gate.
    console.log(JSON.stringify({ variant, ...report }));
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
