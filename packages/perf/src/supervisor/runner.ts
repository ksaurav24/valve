// Executes a plan: trials in seeded order (cells shuffled per rep, arm order rotated), resource
// retries, safety stop, resumable rows, and the staged sequential design (RFC §3): looks are
// preregistered in the manifest, and a cell stops only at a look where every decision metric
// has a non-inconclusive verdict.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeLines, encode } from '../core/codec.ts';
import {
  cellHash,
  runDir,
  writeManifest,
  type RunManifest,
} from '../core/manifest.ts';
import { deriveSeed, mulberry32, shuffle } from '../core/rng.ts';
import type {
  ArmSpec,
  CellSpec,
  DecisionMetric,
  DecisionPlan,
  TrialRecord,
  ViolationClass,
} from '../core/types.ts';
import { aggregate } from '../analyze/aggregate.ts';
import { shouldStop } from '../analyze/sequential.ts';
import type { RunSummary } from '../analyze/summary.ts';
import { estimate, fmtDuration, loadCalibration } from '../plan/budget.ts';
import { runTrial, type TrialContext } from './trial.ts';

export const FATAL: ViolationClass[] = [
  'rate-bound',
  'window-bound',
  'scoped-bound',
  'lease-oversubscription',
  'start-after-abort',
  'maxwait-C1-check-before-deadline',
  'maxwait-late-grant',
  'lost-job',
  'worker-crash',
  'reconciliation',
  'contract',
];

export interface PlannedTrial {
  cell: CellSpec;
  cellHash: string;
  arm: ArmSpec;
  rep: number;
  seed: number;
}

export interface RunOptions {
  manifest: RunManifest;
  /** Arms compared in paired statistics. */
  arms: ArmSpec[];
  /** Instrumented audit arms (correctness), run for rep 0 only; excluded from paired stats. */
  auditArms?: ArmSpec[];
  /** Preregistered looks; a single look means a fixed-n design. */
  looks: number[];
  decision?: DecisionPlan;
  metricsFor(cell: CellSpec): DecisionMetric[];
  trial: Omit<TrialContext, 'runDir'>;
  /** Classes that stop the run immediately, including every deadline violation. */
  stopOn?: ViolationClass[];
  maxAttempts?: number;
  cooldownMs?: number;
  base: string;
  candidates: string[];
  aa?: string;
  log(line: string): void;
  includeTrial?(trial: PlannedTrial): boolean;
}

export function seedFor(baseSeed: number, cell: CellSpec, rep: number) {
  if (cell.suite === 'libs')
    return deriveSeed(baseSeed, cell.id.split('/')[1]!, rep);
  return deriveSeed(baseSeed, cellHash(cell), rep);
}

/** Order trials for reps [from, to): cells shuffled per rep, arm order rotated per cell and rep. */
export function orderTrials(
  cells: readonly CellSpec[],
  arms: readonly ArmSpec[],
  from: number,
  to: number,
  baseSeed: number,
): PlannedTrial[] {
  const out: PlannedTrial[] = [];
  for (let rep = from; rep < to; rep++) {
    const order = shuffle(
      mulberry32(deriveSeed(baseSeed, 'order', rep)),
      cells,
    );
    order.forEach((cell, i) => {
      const k = (rep + i) % arms.length;
      const rotated = [...arms.slice(k), ...arms.slice(0, k)];
      for (const arm of rotated)
        out.push({
          cell,
          cellHash: cellHash(cell),
          arm,
          rep,
          seed: seedFor(baseSeed, cell, rep),
        });
    });
  }
  return out;
}

const rowsFile = (runId: string) => join(runDir(runId), 'rows.jsonl');

export function readRows(runId: string): TrialRecord[] {
  const f = rowsFile(runId);
  return existsSync(f) ? decodeLines<TrialRecord>(readFileSync(f, 'utf8')) : [];
}

export async function executeRun(
  opts: RunOptions,
): Promise<{ rows: TrialRecord[]; summary: RunSummary; stopped?: string }> {
  const m = opts.manifest;
  writeManifest(m);
  const dir = runDir(m.runId);
  const rows = readRows(m.runId);
  const knownArms = new Map(
    [...opts.arms, ...(opts.auditArms ?? [])].map((arm) => [arm.name, arm]),
  );
  const knownCells = new Map(m.cells.map((cell) => [cell.hash, cell.spec]));
  for (const row of rows) {
    const cell = knownCells.get(row.cellHash);
    const arm = knownArms.get(row.arm);
    if (
      !cell ||
      !arm ||
      row.runId !== m.runId ||
      row.cellId !== cell.id ||
      row.fingerprintId !== m.fingerprintId ||
      row.buildDistSha256 !== arm.build.distSha256 ||
      row.seed !== seedFor(m.baseSeed, cell, row.rep)
    )
      throw new Error(
        `Refusing incompatible trial row ${row.trialId}; run identities differ from manifest`,
      );
  }
  const done = new Set(
    rows
      .filter((r) => r.status === 'ok')
      .map((r) => `${r.cellHash}|${r.arm}|${r.rep}`),
  );
  const attempts = new Map<string, number>();
  for (const r of rows)
    attempts.set(
      `${r.cellHash}|${r.arm}|${r.rep}`,
      Math.max(attempts.get(`${r.cellHash}|${r.arm}|${r.rep}`) ?? 0, r.attempt),
    );
  const stopOn = new Set(opts.stopOn ?? FATAL);
  const maxAttempts = opts.maxAttempts ?? 3;
  const cal = loadCalibration();
  const started = Date.now();
  let active = m.cells.map((c) => c.spec);
  let stopped: string | undefined;
  let prev = 0;
  const all = (): TrialRecord[] => readRows(m.runId);

  const runOne = async (t: PlannedTrial): Promise<TrialRecord | undefined> => {
    const key = `${t.cellHash}|${t.arm.name}|${t.rep}`;
    if (done.has(key)) return undefined;
    let rec: TrialRecord | undefined;
    while ((attempts.get(key) ?? 0) < maxAttempts) {
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);
      rec = await runTrial(
        {
          runId: m.runId,
          cell: t.cell,
          cellHash: t.cellHash,
          arm: t.arm,
          rep: t.rep,
          seed: t.seed,
          attempt,
          fingerprintId: m.fingerprintId,
        },
        { ...opts.trial, runDir: dir, harnessSha256: m.harnessSha256 },
      );
      appendFileSync(rowsFile(m.runId), encode(rec) + '\n');
      const fatal = Object.keys(rec.safety.counts).filter((c) =>
        stopOn.has(c as ViolationClass),
      );
      opts.log(
        `[${t.cell.id} ${t.arm.name} r${t.rep} a${attempt}] ${rec.status} ${rec.durationSec.toFixed(1)}s safety=${rec.safety.status}` +
          (rec.status === 'resource-invalid'
            ? ` (${rec.resources.reasons.join(',')})`
            : '') +
          (rec.error
            ? ` error=${rec.error.split('\n')[0]!.slice(0, 160)}`
            : ''),
      );
      if (fatal.length) {
        stopped = `fatal safety violation (${fatal.join(', ')}) in ${t.cell.id} ${t.arm.name} r${t.rep}; run stopped, trial retained`;
        return rec;
      }
      if (rec.status === 'failed') {
        stopped = `trial execution failed in ${t.cell.id}; stopped with evidence retained`;
        return rec;
      }
      if (rec.status !== 'resource-invalid') break;
      await new Promise((r) => setTimeout(r, opts.cooldownMs ?? 10000));
    }
    if (rec?.status === 'ok') done.add(key);
    return rec;
  };

  for (let li = 0; li < opts.looks.length && !stopped; li++) {
    const target = opts.looks[li]!;
    const trials = orderTrials(active, opts.arms, prev, target, m.baseSeed);
    if (opts.auditArms?.length && prev === 0)
      trials.push(...orderTrials(active, opts.auditArms, 0, 1, m.baseSeed));
    const remaining = trials.filter(
      (t) =>
        (opts.includeTrial?.(t) ?? true) &&
        !done.has(`${t.cellHash}|${t.arm.name}|${t.rep}`),
    );
    opts.log(
      `look ${li + 1}/${opts.looks.length}: reps ${prev}..${target - 1}, ${active.length} cells, ${remaining.length} trials, est. ${fmtDuration(estimate(remaining, cal, m.authoritative).withRetriesSeconds)}`,
    );
    for (const t of remaining) {
      await runOne(t);
      if (stopped) break;
    }
    prev = target;
    if (stopped || li === opts.looks.length - 1) break;
    // Interim analysis at a preregistered look: continue only undecided cells.
    const interim = aggregate(
      all(),
      m.cells.map((c) => c.spec),
      {
        base: opts.base,
        candidates: opts.candidates,
        ...(opts.aa ? { aa: opts.aa } : {}),
        ...(opts.decision ? { plan: opts.decision } : {}),
        metricsFor: opts.metricsFor,
        isFinalLook: false,
      },
      placeholderMeta(m),
    );
    active = active.filter((cell) => {
      const c = interim.cells.find((x) => x.cellId === cell.id);
      const verdicts =
        c?.comparisons.filter((x) => x.arm !== opts.aa).map((x) => x.verdict) ??
        [];
      return verdicts.length > 0 && !shouldStop(verdicts);
    });
    opts.log(
      `look ${li + 1} decided ${m.cells.length - active.length} cells; ${active.length} continue`,
    );
    if (!active.length) break;
  }
  const finalRows = all();
  const summary = aggregate(
    finalRows,
    m.cells.map((c) => c.spec),
    {
      base: opts.base,
      candidates: opts.candidates,
      ...(opts.aa ? { aa: opts.aa } : {}),
      ...(opts.decision ? { plan: opts.decision } : {}),
      metricsFor: opts.metricsFor,
      isFinalLook: true,
    },
    { ...placeholderMeta(m), durationSec: (Date.now() - started) / 1000 },
  );
  if (stopped) summary.warnings.push(stopped);
  return { rows: finalRows, summary, ...(stopped ? { stopped } : {}) };
}

export function placeholderMeta(
  m: RunManifest,
): Omit<RunSummary, 'cells' | 'safety' | 'decision'> {
  return {
    runId: m.runId,
    profile: m.profile,
    tier: m.tier,
    createdAt: m.createdAt,
    authoritative: m.authoritative,
    fingerprintId: m.fingerprintId,
    fingerprint: m.fingerprint as unknown as Record<string, unknown>,
    builds: m.builds,
    notExecuted: [],
    warnings: m.authoritative
      ? []
      : [
          `non-authoritative run: ${m.authoritativeReasons.join('; ') || 'isolation not requested'}`,
        ],
    durationSec: 0,
  };
}
