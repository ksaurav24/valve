// Turn trial rows into a RunSummary: per-cell, per-arm metric statistics, paired staged
// comparisons (RFC §3), A/A control, Holm adjustment across cells, and absolute safety.
// Safety uses every trial that produced records, including resource-invalid ones: failures are
// never filtered as noise. Performance statistics use only valid ('ok') trials.
import type {
  CellSpec,
  DecisionMetric,
  DecisionPlan,
  PerfVerdict,
  SafetyReport,
  TrialRecord,
} from '../core/types.ts';
import { mergeSafety, safetyText } from '../oracle/safety.ts';
import { holm, mean, sd, signFlipTest } from './stats.ts';
import { aaVerdict, alphaPerLook, verdictFor } from './sequential.ts';
import type {
  ArmSafety,
  CellSummary,
  Comparison,
  MetricStat,
  RunSummary,
} from './summary.ts';

const performanceValid = (row: TrialRecord) =>
  row.status === 'ok' &&
  row.resources.valid &&
  row.metrics.generatorSaturated !== 1;

export function metricStat(values: (number | null)[]): MetricStat {
  const v = values.filter((x): x is number => x !== null && !Number.isNaN(x));
  const sorted = [...v].sort((a, b) => a - b);
  return {
    n: v.length,
    mean: v.length ? mean(v) : null,
    sd: v.length > 1 && v.every(Number.isFinite) ? sd(v) : null,
    min: sorted[0] ?? null,
    median: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : null,
    max: sorted.at(-1) ?? null,
    values,
  };
}

/** Paired differences `arm - base` by rep, for reps where both values exist. */
export function pairedDiffs(
  rows: readonly TrialRecord[],
  metric: string,
  arm: string,
  base: string,
): { diffs: number[]; baseValues: number[] } {
  const byRep = (name: string) =>
    new Map(
      rows
        .filter((r) => r.arm === name && performanceValid(r))
        .map((r) => [r.rep, r]),
    );
  const b = byRep(base);
  const a = byRep(arm);
  const diffs: number[] = [];
  const baseValues: number[] = [];
  for (const [rep, candidate] of a) {
    const baseline = b.get(rep);
    if (!baseline) continue;
    if (
      candidate.seed !== baseline.seed ||
      candidate.cellHash !== baseline.cellHash ||
      candidate.fingerprintId !== baseline.fingerprintId
    )
      throw new Error(`incompatible paired trial identity at rep ${rep}`);
    const va = candidate.metrics[metric],
      vb = baseline.metrics[metric];
    if (
      typeof va === 'number' &&
      typeof vb === 'number' &&
      Number.isFinite(va) &&
      Number.isFinite(vb)
    ) {
      diffs.push(va - vb);
      baseValues.push(vb);
    }
  }
  return { diffs, baseValues };
}

export interface AggregateOptions {
  base: string;
  /** Candidate arms compared against base (A/A arm handled separately). */
  candidates: string[];
  aa?: string;
  plan?: DecisionPlan;
  metricsFor(cell: CellSpec): DecisionMetric[];
  /** Whether this is the final preregistered look. */
  isFinalLook: boolean;
}

function compare(
  rows: readonly TrialRecord[],
  m: DecisionMetric,
  arm: string,
  base: string,
  plan: DecisionPlan,
  finalLook: boolean,
  aa: boolean,
): Comparison {
  const { diffs, baseValues } = pairedDiffs(rows, m.metric, arm, base);
  const baseMean = baseValues.length ? mean(baseValues) : 0;
  const input = { diffs, metric: m, baseMean, plan, isFinalLook: finalLook };
  const v = verdictFor(input);
  const verdict: PerfVerdict = aa ? aaVerdict(input) : v.verdict;
  const p = v.lo !== null ? signFlipTest(diffs, { seed: 97 }) : null;
  const expectedPairs = rows.reduce(
    (max, row) => Math.max(max, row.rep + 1),
    0,
  );
  if (diffs.length < expectedPairs && v.lo !== null)
    return {
      metric: m.metric,
      arm,
      better: m.better,
      n: diffs.length,
      meanDiff: diffs.length ? mean(diffs) : null,
      lo: null,
      hi: null,
      alphaLook: null,
      margin: v.margin,
      permutationP: null,
      adjustedP: null,
      verdict: 'INCONCLUSIVE',
      reason:
        'Missing, invalid or nonfinite pairs; survivor-only inference withheld.',
    };
  return {
    metric: m.metric,
    arm,
    better: m.better,
    n: diffs.length,
    meanDiff: diffs.length ? mean(diffs) : null,
    lo: v.lo === null ? null : m.better === 'lower' ? -v.hi! : v.lo,
    hi: v.hi === null ? null : m.better === 'lower' ? -v.lo! : v.hi,
    alphaLook: v.lo !== null ? alphaPerLook(plan) : null,
    margin: v.margin,
    permutationP: typeof p === 'number' ? p : null,
    adjustedP: null,
    verdict,
    reason: aa ? `A/A control (${verdict})` : v.reason,
  };
}

export function aggregate(
  rows: readonly TrialRecord[],
  cells: readonly CellSpec[],
  opts: AggregateOptions,
  meta: Omit<RunSummary, 'cells' | 'safety' | 'decision'>,
): RunSummary {
  const plan = opts.plan ?? { metrics: [], looks: [5], alpha: 0.05 };
  // Conservative error control for all declared cell/metric intervals within a suite.
  // This family is fixed by the full planned cell set, including cells decided earlier.
  const suiteFamilies = new Map<string, number>();
  for (const cell of cells)
    suiteFamilies.set(
      cell.suite,
      (suiteFamilies.get(cell.suite) ?? 0) + opts.metricsFor(cell).length,
    );
  const out: CellSummary[] = [];
  for (const cell of cells) {
    const mine = rows.filter((r) => r.cellId === cell.id);
    const expectedArms = [
      opts.base,
      ...opts.candidates,
      ...(opts.aa ? [opts.aa] : []),
    ];
    const arms = [...new Set([...expectedArms, ...mine.map((r) => r.arm)])];
    const incomplete = expectedArms.some(
      (arm) => !mine.some((r) => r.arm === arm && r.status === 'ok'),
    );
    const failedTrial = mine.some(
      (r) => r.status === 'failed' || r.status === 'aborted',
    );
    const metrics: CellSummary['metrics'] = {};
    const outcomes: CellSummary['outcomes'] = {};
    const safety: ArmSafety[] = [];
    const invalid: Record<string, number> = {};
    for (const arm of arms) {
      const armRows = mine.filter((r) => r.arm === arm);
      const ok = armRows.filter(performanceValid);
      invalid[arm] = armRows.length - ok.length;
      const names = [
        ...new Set(ok.flatMap((r) => Object.keys(r.metrics))),
      ].sort();
      metrics[arm] = Object.fromEntries(
        names.map((n) => [
          n,
          metricStat(
            ok.sort((a, b) => a.rep - b.rep).map((r) => r.metrics[n] ?? null),
          ),
        ]),
      );
      const o: Record<string, Record<string, number>> = {};
      for (const r of ok)
        for (const [cohort, counts] of Object.entries(r.outcomes))
          for (const [k, v] of Object.entries(counts))
            (o[cohort] ??= {})[k] = (o[cohort][k] ?? 0) + v;
      outcomes[arm] = o;
      const merged: SafetyReport = mergeSafety(armRows.map((r) => r.safety));
      const failed = armRows.filter((r) => r.status === 'failed').length;
      safety.push({
        arm,
        status: failed
          ? 'FAIL'
          : armRows.some((r) => r.status === 'aborted') &&
              merged.status !== 'FAIL'
            ? 'UNVERIFIED'
            : merged.status,
        trials: armRows.length,
        counts: merged.counts,
        unverified: merged.unverified,
        samples: [
          ...merged.samples.map((s) => `${s.class}: ${s.detail}`),
          ...(failed
            ? [
                `${failed} trial(s) failed to complete: ${armRows.find((r) => r.status === 'failed')?.error?.slice(0, 200) ?? ''}`,
              ]
            : []),
        ].slice(0, 20),
      });
    }
    const comparisons: Comparison[] = [];
    const cellPlan = {
      ...plan,
      alpha: plan.alpha / Math.max(1, suiteFamilies.get(cell.suite) ?? 1),
    };
    let aaWorst: PerfVerdict | undefined;
    if (arms.includes(opts.base)) {
      const decision = opts.metricsFor(cell);
      if (opts.aa && arms.includes(opts.aa)) {
        for (const m of decision) {
          const c = compare(
            mine,
            m,
            opts.aa,
            opts.base,
            cellPlan,
            opts.isFinalLook,
            true,
          );
          comparisons.push(c);
          if (c.verdict === 'UNSTABLE') aaWorst = 'UNSTABLE';
          else if (!aaWorst && c.verdict !== 'EQUIVALENT') aaWorst = c.verdict;
        }
        aaWorst ??= 'EQUIVALENT';
      }
      for (const arm of opts.candidates.filter((a) => arms.includes(a)))
        for (const m of decision) {
          const c = compare(
            mine,
            m,
            arm,
            opts.base,
            cellPlan,
            opts.isFinalLook,
            false,
          );
          // Instability in any preregistered A/A metric invalidates the cell.
          if (
            ((opts.aa !== undefined && aaWorst !== 'EQUIVALENT') ||
              incomplete ||
              failedTrial) &&
            c.verdict !== 'DESCRIPTIVE'
          ) {
            const reason = failedTrial
              ? 'failed or aborted trial in cell'
              : incomplete
                ? 'planned arm has no valid trial'
                : 'A/A control unresolved or unstable for cell';
            c.reason = `${reason}; ${c.verdict} withheld (${c.reason})`;
            c.verdict = 'INCONCLUSIVE';
          }
          comparisons.push(c);
        }
    }
    out.push({
      cellId: cell.id,
      suite: cell.suite,
      description: describe(cell),
      tags: cell.tags,
      notes: [
        ...new Set([
          ...(cell.notes ?? []),
          ...mine.flatMap((row) => row.notes ?? []),
          ...(mine.some((row) => row.metrics.generatorSaturated === 1)
            ? [
                'Generator saturation: affected trials excluded from performance inference; safety evidence retained.',
              ]
            : []),
        ]),
      ],
      arms,
      metrics,
      outcomes,
      safety,
      comparisons,
      invalidTrials: invalid,
      ...(aaWorst ? { aaVerdict: aaWorst } : {}),
    });
  }
  // Holm across cells within each (arm, metric) family for regression flags.
  const families = new Map<string, Comparison[]>();
  for (const cell of out)
    for (const c of cell.comparisons)
      if (c.arm !== opts.aa && c.permutationP !== null) {
        const key = `${cell.suite}|${c.arm}|${c.metric}`;
        (families.get(key) ?? families.set(key, []).get(key)!).push(c);
      }
  for (const list of families.values()) {
    const adj = holm(list.map((c) => c.permutationP!));
    list.forEach((c, i) => (c.adjustedP = adj[i]!));
  }
  const all = out.flatMap((c) => c.safety);
  const safety = all.some((s) => s.status === 'FAIL')
    ? 'FAIL'
    : all.some((s) => s.status === 'UNVERIFIED') || !all.length
      ? 'UNVERIFIED'
      : 'PASS';
  return {
    ...meta,
    ...(opts.plan ? { decision: opts.plan } : {}),
    safety,
    cells: out,
  };
}

/** Short human description of a cell. */
export function describe(cell: CellSpec): string {
  const rules = (cell.rules ?? []).map(
    (r) =>
      `${r.algorithm === 'fixed-window' ? 'fixed' : 'gcra'} ${r.limit}/${r.intervalMs}ms${r.burst && r.burst > 1 ? ` b${r.burst}` : ''}${r.scope ? ` per ${r.scope}` : ''}`,
  );
  const c = cell.concurrency;
  const conc =
    c === undefined
      ? ''
      : typeof c === 'number'
        ? `local conc ${c}`
        : `${c.scope} conc ${c.limit}`;
  const store =
    cell.store.kind === 'memory'
      ? 'memory'
      : `${cell.store.server}${cell.store.subscriber ? '+sub' : ''}`;
  const a = cell.workload.arrival;
  const arrival =
    a.kind === 'backlog'
      ? `backlog ${a.depth}`
      : a.kind === 'clients'
        ? `${a.clients} clients`
        : 'ratePerSec' in a
          ? `${a.kind} ${a.ratePerSec}/s`
          : a.kind;
  return [
    cell.library,
    `${cell.workers}w`,
    ...rules,
    conc,
    store,
    arrival,
    cell.workload.job.kind,
    cell.network
      ? `rtt ${cell.network.delayMs}±${cell.network.jitterMs}ms`
      : '',
    cell.faults?.length
      ? `faults: ${cell.faults.map((f) => f.type).join(',')}`
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Lines summarizing safety then performance, for the console. */
export function consoleSummary(s: RunSummary): string[] {
  const lines = [`SAFETY: ${s.safety}`];
  for (const c of s.cells)
    for (const a of c.safety)
      if (a.status !== 'PASS')
        lines.push(
          `  ${c.cellId} [${a.arm}] ${safetyText({ status: a.status, checked: [], unverified: a.unverified, counts: a.counts, samples: [] })}`,
        );
  const verdicts = s.cells.flatMap((c) =>
    c.comparisons
      .filter((x) => x.arm !== 'aa')
      .map((x) => `${c.cellId} ${x.arm} ${x.metric}: ${x.verdict}`),
  );
  if (verdicts.length)
    lines.push('PERFORMANCE:', ...verdicts.map((v) => `  ${v}`));
  return lines;
}
