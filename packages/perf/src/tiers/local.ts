// Portable tiers and host calibration. No containers are started here.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encode } from '../core/codec.ts';
import {
  authoritativeCapability,
  captureFingerprint,
  fingerprintId,
} from '../core/fingerprint.ts';
import {
  cellHash,
  planHash,
  runDir,
  writeManifest,
  type RunManifest,
} from '../core/manifest.ts';
import { ensureDir, perfDir, stateDir } from '../core/paths.ts';
import type { BuildIdentity, CellSpec } from '../core/types.ts';
import { currentBuild, entryUrls, harnessSha256 } from '../identity/build.ts';
import { runMicro } from '../micro/run.ts';
import { idealBound, ruleCapacity } from '../model/capacity.ts';
import { simulate } from '../model/sim.ts';
import type { Rule } from '../model/state.ts';
import { LEGACY_CALIBRATION, saveCalibration } from '../plan/budget.ts';
import { resolveEndpoint } from '../infra/safety.ts';
import { imageId, readInfra } from '../infra/servers.ts';
import { c1Safety, reproduceC1 } from './c1.ts';
import { runTrial } from '../supervisor/trial.ts';

const median = (xs: number[]) =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

function localManifest(
  tier: 'micro' | 'model' | 'calibrate' | 'c1',
  build: BuildIdentity,
): RunManifest {
  const fingerprint = captureFingerprint();
  const m: RunManifest = {
    version: 1,
    runId: `${tier}-${Date.now()}-${randomUUID().slice(0, 8)}`,
    tier,
    profile: tier,
    createdAt: new Date().toISOString(),
    command: process.argv.slice(2),
    harnessSha256: harnessSha256(),
    fingerprint,
    fingerprintId: fingerprintId(fingerprint),
    authoritative: false,
    authoritativeReasons: ['portable local tier'],
    builds: { current: build },
    arms: [],
    cells: [],
    reps: 1,
    baseSeed: 42,
    planHash: '',
    estimateSec: 0,
    servers: {},
  };
  m.planHash = planHash(m);
  writeManifest(m);
  return m;
}

export async function doctor(
  log: (line: string) => void = console.log,
): Promise<number> {
  const images = Object.fromEntries(
    Object.entries(readInfra().servers).map(([name, server]) => [
      name,
      imageId(server),
    ]),
  );
  const fingerprint = captureFingerprint(images);
  const lateness: number[] = [];
  for (let i = 0; i < 30; i++) {
    const start = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 2));
    lateness.push(Math.max(0, performance.now() - start - 2));
  }
  lateness.sort((a, b) => a - b);
  fingerprint.timerLateness = {
    p50: lateness[15]!,
    p99: lateness[29]!,
    max: lateness[29]!,
  };
  const result = {
    fingerprintId: fingerprintId(fingerprint),
    fingerprint,
    authoritativeCapability: authoritativeCapability(fingerprint),
  };
  writeFileSync(join(ensureDir(stateDir), 'doctor.json'), encode(result, 2));
  log(encode(result, 2));
  return Number(Number(process.versions.node.split('.')[0]) < 24);
}

export async function micro(
  options: { quick?: boolean; filter?: string | undefined; rebuild?: boolean },
  log: (line: string) => void = console.log,
): Promise<number> {
  const build = currentBuild({ rebuild: options.rebuild ?? true });
  const manifest = localManifest('micro', build);
  const rows = await runMicro({
    quick: options.quick ?? false,
    valveModuleUrl: entryUrls(build).index,
    ...(options.filter ? { filter: options.filter } : {}),
  });
  if (!rows.length) throw new Error('No microbenchmark tasks match --filter');
  writeFileSync(join(runDir(manifest.runId), 'micro.json'), encode(rows, 2));
  for (const row of rows)
    log(
      `${row.suite}/${row.task}: ${row.nsPerOp.toFixed(1)} ns/op, ${row.samples} samples`,
    );
  log(
    `T0 raw absolutes; no distributed claims. Results: ${runDir(manifest.runId)}`,
  );
  return 0;
}

export async function model(
  log: (line: string) => void = console.log,
): Promise<number> {
  const build = currentBuild();
  // Run the committed proof/self-test suite rather than duplicating its assertions in the CLI.
  const tests = [
    'model',
    'model-memory-parity',
    'survival',
    'quantile',
    'stats',
    'sequential',
    'oracle',
    'oracles',
  ].map((name) => `test/${name}.test.ts`);
  tests.push(
    'test/oracle/correctness.test.ts',
    'test/analyze/correctness.test.ts',
  );
  const existing = tests.filter((name) => existsSync(join(perfDir, name)));
  execFileSync('pnpm', ['exec', 'vitest', 'run', ...existing], {
    cwd: perfDir,
    stdio: 'inherit',
  });
  const manifest = localManifest('model', build);
  const rules: Rule[] = [
    { algorithm: 'gcra', limit: 100, intervalMs: 1000, burst: 5 },
  ];
  const result = {
    kind: 'abstract-client-model',
    caveat:
      'Admission model and declared client policy; does not simulate Valve scheduler behavior. Redis parity requires test:integration.',
    ruleCapacity: ruleCapacity(rules, 1000),
    idealBound: idealBound({
      rules,
      t0: 0,
      t1: 1000,
      prefix: true,
      demand: { saturated: { cost: 1 } },
    }),
    simulation: simulate({
      rules,
      clients: 4,
      queue: { backlog: 8 },
      policy: {
        batch: 4,
        retry: 'hint',
        oneInFlight: true,
        rttMs: { kind: 'fixed', ms: 1 },
        timerLateness: { kind: 'fixed', ms: 0 },
      },
      seed: 42,
      t0: 0,
      t1: 1000,
    }),
    selfTests: existing,
  };
  writeFileSync(join(runDir(manifest.runId), 'model.json'), encode(result, 2));
  log(`${result.caveat}\nResults: ${runDir(manifest.runId)}`);
  return 0;
}

/** Measure actual cold-process trial overhead on low-rate memory cells (1 and 4 workers). */
export async function calibrate(
  reps = 3,
  log: (line: string) => void = console.log,
): Promise<number> {
  const build = currentBuild();
  const manifest = localManifest('calibrate', build);
  const rows = [];
  const overhead = new Map<number, number[]>();
  for (const workers of [1, 4]) {
    const values: number[] = [];
    overhead.set(workers, values);
    const cell: CellSpec = {
      id: `calibrate/${workers}`,
      suite: 'calibrate',
      library: 'identity',
      mechanism: 'local-concurrency',
      workers,
      store: { kind: 'memory' },
      priority: 0,
      tags: ['calibration'],
      timing: { warmupMs: 0, windowMs: 100, drainMs: 100 },
      workload: {
        arrival: { kind: 'periodic', ratePerSec: 10 },
        job: { kind: 'noop' },
      },
    };
    for (let rep = 0; rep < reps; rep++) {
      const row = await runTrial(
        {
          runId: manifest.runId,
          cell,
          cellHash: cellHash(cell),
          arm: { name: 'base', build, instrument: 'none' },
          rep,
          seed: 42 + rep,
          attempt: 1,
          fingerprintId: manifest.fingerprintId,
        },
        { runDir: runDir(manifest.runId), authoritative: false, log },
      );
      rows.push(row);
      if (row.status !== 'ok')
        throw new Error(`Calibration trial failed: ${row.error ?? row.status}`);
      values.push(
        Math.max(
          0,
          row.durationSec - (cell.timing.windowMs + cell.timing.drainMs) / 1000,
        ),
      );
      log(
        `calibrate ${workers} workers rep ${rep + 1}: ${row.durationSec.toFixed(3)} s`,
      );
    }
  }
  const one = median(overhead.get(1)!);
  const four = median(overhead.get(4)!);
  const perWorkerSec = Math.max(0, (four - one) / 3);
  const calibration = {
    ...LEGACY_CALIBRATION,
    baseSec: Math.max(0, one - perWorkerSec),
    perWorkerSec,
    measuredAt: new Date().toISOString(),
    source: `cold low-rate memory trials, ${reps} reps at 1/4 workers; quiet/rejection policy inherited (not measured)`,
  };
  saveCalibration(calibration);
  writeFileSync(
    join(runDir(manifest.runId), 'calibration-trials.json'),
    encode(rows, 2),
  );
  log(encode(calibration, 2));
  return 0;
}

/** Persist deadline regression verification with the same provenance as other tiers. */
export async function c1(
  options: { stores?: string[] | undefined; endpoint?: string | undefined },
  log: (line: string) => void = console.log,
): Promise<number> {
  const build = currentBuild();
  const manifest = localManifest('c1', build);
  const registered = readInfra().servers;
  const defaultRedis = ['redis74', 'valkey8'].find((name) => registered[name]);
  const stores =
    options.stores ??
    (options.endpoint
      ? ['external']
      : ['memory', ...(defaultRedis ? [defaultRedis] : [])]);
  const results = [];
  for (const store of stores) {
    const result = await reproduceC1(
      build,
      store === 'memory'
        ? {}
        : { redisUrl: resolveEndpoint(options.endpoint ?? store).url },
    );
    results.push({ ...result, store });
    writeFileSync(join(runDir(manifest.runId), 'c1.json'), encode(results, 2));
    log(
      `${result.safety === 'PASS' ? 'PASS - DEADLINE REGRESSION CHECK' : result.safety === 'FAIL' ? 'FAIL - KNOWN DEFECT REPRODUCED' : 'UNVERIFIED - expected deadline rejection not established'} ${encode({ ...result, store })}`,
    );
  }
  log(`Results: ${runDir(manifest.runId)}`);
  const safety = c1Safety(results);
  return safety === 'PASS' ? 0 : safety === 'FAIL' ? 1 : 2;
}
