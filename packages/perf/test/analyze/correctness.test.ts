import { describe, expect, it } from 'vitest';
import { aggregate, metricStat } from '../../src/analyze/aggregate.ts';
import {
  analyzeTrial,
  boundFor,
  type TrialData,
} from '../../src/analyze/trial.ts';
import {
  aaVerdict,
  shouldStop,
  verdictFor,
} from '../../src/analyze/sequential.ts';
import {
  Cohort,
  Outcome,
  type CellSpec,
  type DecisionMetric,
  type DecisionPlan,
  type JobRecord,
  type TrialRecord,
} from '../../src/core/types.ts';
import type { RunSummary } from '../../src/analyze/summary.ts';
import { safetyReport } from '../../src/oracle/safety.ts';
import { metricsFor } from '../../src/plan/profiles.ts';

const metric = { metric: 'throughput', better: 'higher' as const, margin: 1 };
const plan: DecisionPlan = {
  metrics: [metric],
  looks: [5, 10, 20],
  alpha: 0.05,
};
function cell(): CellSpec {
  return {
    id: 'gcra/basic',
    suite: 'gcra',
    library: 'valve',
    mechanism: 'gcra',
    workers: 1,
    rules: [{ limit: 1, intervalMs: 10 }],
    store: { kind: 'memory' },
    workload: {
      arrival: { kind: 'backlog', depth: 10 },
      job: { kind: 'noop' },
    },
    timing: { warmupMs: 0, windowMs: 10, drainMs: 0 },
    priority: 0,
    tags: [],
  };
}
function row(
  arm: string,
  rep: number,
  metrics: TrialRecord['metrics'] = { throughput: arm === 'base' ? 10 : 8 },
): TrialRecord {
  return {
    runId: 'test',
    trialId: `${arm}-${rep}`,
    cellId: cell().id,
    cellHash: 'cell',
    arm,
    rep,
    seed: rep,
    attempt: 0,
    fingerprintId: 'fp',
    buildDistSha256: 'build',
    startedAt: '',
    durationSec: 0,
    status: 'ok',
    metrics,
    outcomes: {},
    safety: safetyReport([], ['lost-job'], []),
    resources: { valid: true, authoritative: false, reasons: [] },
  };
}
const meta: Omit<RunSummary, 'cells' | 'safety' | 'decision'> = {
  runId: 'test',
  profile: 'decision',
  tier: 'T3',
  createdAt: '',
  authoritative: false,
  fingerprintId: 'fp',
  fingerprint: {},
  builds: {},
  notExecuted: [],
  warnings: [],
  durationSec: 0,
};
function summary(rows: TrialRecord[], metrics: DecisionMetric[] = [metric]) {
  return aggregate(
    rows,
    [cell()],
    {
      base: 'base',
      candidates: ['head'],
      ...(rows.some((r) => r.arm === 'aa') ? { aa: 'aa' } : {}),
      plan,
      metricsFor: () => metrics,
      isFinalLook: true,
    },
    meta,
  );
}
function data(c = cell()): TrialData {
  return {
    cell: c,
    seed: 1,
    epochAt: 1000,
    quotaId: 'test',
    jobs: [],
    calls: [],
    summaries: [],
    killedWorkers: new Set(),
    resets: [],
    asymmetric: false,
  };
}
function job(i: number, overrides: Partial<JobRecord>): JobRecord {
  return {
    w: 0,
    i,
    k: Cohort.open,
    ia: 1000,
    sa: 1000,
    st: -1,
    en: -1,
    o: Outcome.unserved,
    c: 1,
    mw: -1,
    ab: -1,
    rp: -1,
    sd: 1000,
    sdStart: -1,
    ...overrides,
  };
}

describe('aggregation evidence', () => {
  it('does not gate a single-worker A/A control on inapplicable fairness', () => {
    const c = cell();
    const decision = metricsFor(c);
    expect(decision.some((m) => m.metric === 'jain')).toBe(false);
    expect(
      metricsFor({ ...c, workers: 2 }).some((m) => m.metric === 'jain'),
    ).toBe(true);
    const values = Object.fromEntries(decision.map((m) => [m.metric, 100]));
    const rows = Array.from({ length: 5 }, (_, rep) => [
      row('base', rep, values),
      row('aa', rep, values),
    ]).flat();
    const result = aggregate(
      rows,
      [c],
      {
        base: 'base',
        candidates: [],
        aa: 'aa',
        plan: { metrics: decision, looks: [5], alpha: 0.05 },
        metricsFor,
        isFinalLook: true,
      },
      meta,
    );
    expect(result.cells[0]!.aaVerdict).toBe('EQUIVALENT');
  });
  it('does not discard not-reached rep quantiles from raw summaries', () => {
    expect(metricStat([1, Infinity, null])).toMatchObject({
      n: 2,
      mean: Infinity,
      sd: null,
      max: Infinity,
    });
  });
  it('withholds inference when ten surviving pairs come from twenty planned reps', () => {
    const rows = Array.from({ length: 20 }, (_, rep) => [
      row('base', rep),
      row('head', rep, { throughput: rep < 10 ? 8 : Infinity }),
    ]).flat();
    expect(summary(rows).cells[0]!.comparisons[0]).toMatchObject({
      n: 10,
      verdict: 'INCONCLUSIVE',
      lo: null,
      hi: null,
    });
  });
  it('reports lower-is-better intervals in the same raw arm-minus-base units as their means', () => {
    const rows = Array.from({ length: 5 }, (_, rep) => [
      row('base', rep),
      row('head', rep),
    ]).flat();
    const lower = { ...metric, better: 'lower' as const };
    expect(summary(rows, [lower]).cells[0]!.comparisons[0]).toMatchObject({
      meanDiff: -2,
      lo: -2,
      hi: -2,
      verdict: 'IMPROVEMENT',
    });
  });
  it('keeps missing planned arms visible and refuses survivor-only inference after a crash', () => {
    const rows = Array.from({ length: 5 }, (_, rep) => [
      row('base', rep),
      row('head', rep),
    ]).flat();
    const opts = {
      base: 'base',
      candidates: ['head'],
      aa: 'aa',
      plan,
      metricsFor: () => [metric],
      isFinalLook: true,
    };
    const missing = aggregate(rows, [cell()], opts, meta);
    expect(missing.safety).toBe('UNVERIFIED');
    expect(missing.cells[0]!.safety.find((s) => s.arm === 'aa')).toMatchObject({
      status: 'UNVERIFIED',
      trials: 0,
    });
    expect(
      missing.cells[0]!.comparisons.find((c) => c.arm === 'head')!.verdict,
    ).toBe('INCONCLUSIVE');
    const failed = row('head', 5);
    failed.status = 'failed';
    failed.error = 'worker exited';
    const crashed = summary([...rows, failed]);
    expect(crashed.safety).toBe('FAIL');
    expect(crashed.cells[0]!.comparisons[0]!.verdict).toBe('INCONCLUSIVE');
    expect(aggregate([], [cell()], opts, meta).cells[0]!.arms).toEqual([
      'base',
      'head',
      'aa',
    ]);
  });
  it('uses the exact sign-flip probability for constant differences, never zero', () => {
    const rows = Array.from({ length: 5 }, (_, rep) => [
      row('base', rep),
      row('head', rep),
    ]).flat();
    expect(summary(rows).cells[0]!.comparisons[0]).toMatchObject({
      n: 5,
      permutationP: 2 / 32,
      verdict: 'REGRESSION',
    });
  });
  it('retains absolute failures from invalid trials even when no classes were checked', () => {
    const failed = row('head', 0);
    failed.status = 'resource-invalid';
    failed.safety = safetyReport(
      [{ class: 'lost-job', detail: 'lost' }],
      [],
      [],
    );
    const result = summary([row('head', 1), failed]);
    expect(result.safety).toBe('FAIL');
    expect(
      result.cells[0]!.safety.find((s) => s.arm === 'head')!.counts['lost-job'],
    ).toBe(1);
    expect(result.cells[0]!.comparisons[0]!.verdict).toBe('DESCRIPTIVE');
  });
  it('does not hide missing preregistered metrics or stop on an empty metric set', () => {
    const missing = { ...metric, metric: 'missing' };
    const result = summary([row('base', 0), row('head', 0)], [missing]);
    expect(result.cells[0]!.comparisons[0]).toMatchObject({
      metric: 'missing',
      verdict: 'DESCRIPTIVE',
      n: 0,
    });
    expect(shouldStop([])).toBe(false);
  });
  it('withholds every candidate metric when any A/A metric makes the cell unstable', () => {
    const latency = { ...metric, metric: 'latency' };
    const rows = Array.from({ length: 5 }, (_, rep) => [
      row('base', rep, { throughput: 10, latency: 10 }),
      row('aa', rep, { throughput: 10.2, latency: 10 }),
      row('head', rep, { throughput: 8, latency: 8 }),
    ]).flat();
    const result = summary(rows, [metric, latency]).cells[0]!;
    expect(result.aaVerdict).toBe('UNSTABLE');
    expect(
      result.comparisons.filter((c) => c.arm === 'head').map((c) => c.verdict),
    ).toEqual(['INCONCLUSIVE', 'INCONCLUSIVE']);
  });
  it('makes no inference at unregistered looks or from nonfinite data', () => {
    for (const diffs of [Array<number>(6).fill(-2), [0, 0, 0, 0, NaN]]) {
      const input = { diffs, metric, plan, baseMean: 10, isFinalLook: true };
      expect(verdictFor(input)).toMatchObject({
        verdict: 'INCONCLUSIVE',
        lo: null,
        hi: null,
      });
      expect(aaVerdict(input)).toBe('INCONCLUSIVE');
    }
  });
});

describe('trial denominators and censoring', () => {
  it('requires an external restart checkpoint even when missing grants are not observable', () => {
    const d = data();
    d.events = [];
    d.resets = [1005];
    const incomplete = analyzeTrial(d);
    expect(incomplete.safety.status).toBe('UNVERIFIED');
    expect(incomplete.metrics.admittedPerSec).toBeNull();
    expect(incomplete.safety.unverified).toContain('reconciliation');
    d.restartAuditComplete = true;
    expect(analyzeTrial(d).safety.status).toBe('PASS');
    d.calls = [{ w: 0, op: 'acquire', t0: 1001, t1: 1002, g: 1, n: 1, ra: 0 }];
    expect(analyzeTrial(d).safety.counts).toEqual({ reconciliation: 1 });
  });
  it('fails reconciliation and withholds exact server metrics when grant logs are incomplete', () => {
    const d = data();
    d.events = [];
    d.calls = [{ w: 0, op: 'acquire', t0: 1001, t1: 1002, g: 2, n: 2, ra: 0 }];
    d.jobs = [job(0, { st: 1003, en: 1004, o: Outcome.completed })];
    const result = analyzeTrial(d);
    expect(result.safety).toMatchObject({
      status: 'FAIL',
      counts: { reconciliation: 1 },
    });
    expect(result.metrics.admittedPerSec).toBeNull();
    expect(result.metrics.capacityUtilization).toBeNull();
    expect(result.metrics.clientGrantsPerSec).toBe(200);
  });
  it('aligns fixed-window bounds to the actual epoch', () => {
    const c = cell();
    c.rules = [{ algorithm: 'fixed-window', intervalMs: 10, limit: 1 }];
    c.timing.windowMs = 2;
    expect(boundFor(c, 1, true, 1009)).toBe(2);
    expect(boundFor(c, 1, true, 1000)).toBe(1);
  });
  it('uses the fresh measured quota after separate warmup and withholds truncated synthetic backlog bounds', () => {
    const c = cell();
    c.timing.warmupMs = 1;
    expect(boundFor(c, 1, true)).toBe(1);
    c.timing.warmupMs = 0;
    c.workload.job.costs = { values: [1], weights: [1] };
    expect(boundFor(c, 1, true)).toBeNull();
  });
  it('does not multiply shared rules by scoped identity counts', () => {
    const c = cell();
    c.rules = [
      { name: 'tenant', scope: 'tenant', limit: 1, intervalMs: 10 },
      { name: 'shared', limit: 3, intervalMs: 10 },
    ];
    c.workload.job.scopes = [{ dimension: 'tenant', identities: 10 }];
    expect(analyzeTrial(data(c)).metrics.ruleCapacityPerSec).toBe(300);
    c.rules = [
      { name: 'tenant', scope: 'tenant', limit: 1, intervalMs: 10 },
      { name: 'region', scope: 'region', limit: 2, intervalMs: 10 },
    ];
    c.workload.job.scopes.push({ dimension: 'region', identities: 2 });
    expect(analyzeTrial(data(c)).metrics.ruleCapacityPerSec).toBe(400);
  });
  it("uses each unserved job's actual observation end for right-censoring", () => {
    const d = data();
    d.cell.timing.drainMs = 20;
    d.jobs = [
      job(0, { st: 1002, en: 1002, o: Outcome.completed }),
      job(1, { st: 1015, en: 1015, o: Outcome.completed }),
      job(2, { en: 1004, o: Outcome.expired }),
      job(3, { en: 1008 }),
    ];
    expect(analyzeTrial(d).metrics['open.cifMaxStart']).toBe(0.75);
  });
});
