// Metrics, outcomes and safety for one trial window. Quantities from RFC §2 are kept separate:
// offered demand, theoretical rule capacity, the labelled ideal bound (zero-latency, NOT
// attainable), admitted, useful starts and completions. Latency follows RFC §3: counts first,
// then conditional, Aalen-Johansen CIF and failure-ranked views.
import { Cohort, Outcome } from '../core/types.ts';
import type {
  CallRecord,
  CellSpec,
  JobRecord,
  MetricMap,
  SafetyReport,
  ServerEvent,
  Violation,
  ViolationClass,
  WorkerSummary,
} from '../core/types.ts';
import { mean as distMean } from '../core/rng.ts';
import { demandIsExogenous, fleetSchedule } from '../workload/schedule.ts';
import { idealBound, ruleCapacity } from '../model/capacity.ts';
import type { Rule } from '../model/state.ts';
import {
  checkLeases,
  checkRates,
  classifyZeroGrants,
} from '../oracle/server.ts';
import { checkClient } from '../oracle/client.ts';
import { competitorContract } from '../oracle/competitor.ts';
import { safetyReport } from '../oracle/safety.ts';
import { jain } from './stats.ts';
import { startTimeSummary, type StartTimeRecord } from './survival.ts';
import type { InfoDelta } from '../infra/info.ts';
import { leakVerdict, recoveryMs, slope } from './trend.ts';

export interface TrialData {
  cell: CellSpec;
  seed: number;
  epochAt: number;
  quotaId: string;
  jobs: JobRecord[];
  calls: CallRecord[];
  summaries: WorkerSummary[];
  /** Instrumented server log (correctness arms), execution order. */
  events?: ServerEvent[];
  info?: InfoDelta;
  killedWorkers: Set<number>;
  /** Epoch times at which store state was lost (restart faults). */
  resets: number[];
  /** Every reset has an external snapshot protected against intervening writes. */
  restartAuditComplete?: boolean;
  /** Planned churn or faults: fairness is not an equal-share test then. */
  asymmetric: boolean;
  /** Fault log, times relative to the epoch (ms). */
  faultLog?: {
    type: string;
    firedAtMs: number;
    doneAtMs?: number;
    error?: string;
  }[];
  /** Soak samples from workers and the Redis server. */
  samples?: { w: number; t: number; heap: number; rss: number }[];
  redisSamples?: { t: number; usedMemory: number; keys: number }[];
}

export interface TrialAnalysis {
  metrics: MetricMap;
  outcomes: Record<string, Record<string, number>>;
  safety: SafetyReport;
  notes: string[];
}

const COHORTS: Record<number, string> = {
  [Cohort.backlog]: 'backlog',
  [Cohort.open]: 'open',
  [Cohort.urgent]: 'urgent',
  [Cohort.client]: 'client',
};
const OUTCOME_NAMES: Record<number, string> = {
  [Outcome.pending]: 'lost',
  [Outcome.completed]: 'completed',
  [Outcome.failed]: 'failed',
  [Outcome.expired]: 'expired',
  [Outcome.aborted]: 'aborted',
  [Outcome.rejected]: 'rejected',
  [Outcome.unserved]: 'unserved',
};

/** Model rules for a cell (fixed windows always have burst 1, like normalize()). */
export function modelRules(cell: CellSpec): Rule[] {
  return (cell.rules ?? []).map((r, i) => {
    const algorithm = r.algorithm ?? 'gcra';
    return {
      algorithm,
      intervalMs: r.intervalMs,
      limit: r.limit,
      burst: algorithm === 'gcra' ? (r.burst ?? 1) : 1,
      key: r.name ?? `${algorithm}:${r.intervalMs}:${i}`,
    };
  });
}

function leaseOf(cell: CellSpec): { limit: number; ttlMs: number } | undefined {
  const c = cell.concurrency;
  return typeof c === 'object' && c.scope === 'global'
    ? { limit: c.limit, ttlMs: c.leaseTtlMs ?? 30000 }
    : undefined;
}

/** Scope keys per rule for an arrival (shared rules use a constant key). */
function scopeKeys(
  cell: CellSpec,
  scopes: Record<string, string> | undefined,
): string[] | undefined {
  if (!cell.rules?.some((r) => r.scope)) return undefined;
  return cell.rules.map((r, i) =>
    r.scope ? `${r.name ?? i}:${scopes?.[r.scope] ?? '?'}` : `${r.name ?? i}`,
  );
}

/** Memory-store and local-library cells give every worker process an independent budget. */
export const independentBudgets = (cell: CellSpec) =>
  cell.store.kind === 'memory';

/** Ideal-supply bound over the offered demand of this cell, from the empty state of a fresh quota id. */
export function boundFor(
  cell: CellSpec,
  seed: number,
  prefix: boolean,
  epochAt = 0,
): number | null {
  // The driver warms a separate quota id; the measured id starts empty.
  // Reset faults invalidate a single uninterrupted-state counterfactual.
  if (cell.faults?.length || cell.library !== 'valve') return null;
  if (independentBudgets(cell) && cell.workers > 1) {
    // Sum of per-worker bounds over each worker's own offered demand.
    let total = 0;
    for (let w = 0; w < cell.workers; w++) {
      const one = boundForWorkers(cell, seed, prefix, [w], epochAt);
      if (one === null) return null;
      total += one;
    }
    return total;
  }
  return boundForWorkers(
    cell,
    seed,
    prefix,
    Array.from({ length: cell.workers }, (_, w) => w),
    epochAt,
  );
}

function boundForWorkers(
  cell: CellSpec,
  seed: number,
  prefix: boolean,
  workers: number[],
  epochAt: number,
): number | null {
  if (cell.controls?.length) return null;
  const rules = modelRules(cell);
  const lease = leaseOf(cell);
  if (!rules.length && !lease) return null;
  if (!demandIsExogenous(cell)) return null;
  const windowMs = cell.timing.windowMs;
  let demand: Parameters<typeof idealBound>[0]['demand'];
  const arrival = cell.workload.arrival;
  if (arrival.kind === 'backlog') {
    const simple =
      !cell.workload.job.costs &&
      !cell.workload.job.scopes &&
      (!lease || cell.workload.job.kind === 'noop');
    if (simple)
      demand = { saturated: { cost: 1, ...(lease ? { durationMs: 0 } : {}) } };
    else {
      // A finite generated backlog cannot prove infinite demand never drains.
      // General weighted/scoped/duration streams need a lazy saturated model.
      return null;
    }
  } else {
    demand = {
      arrivals: fleetSchedule(cell, seed)
        .filter((a) => workers.includes(a.worker))
        .map((a) => {
          const keys = scopeKeys(cell, a.scopes);
          return {
            at: epochAt + a.at,
            cost: a.cost,
            ...(lease ? { durationMs: a.durationMs } : {}),
            ...(keys ? { scopeKeys: keys } : {}),
          };
        }),
    };
  }
  if (lease && 'saturated' in demand && !rules.length) return null;
  return idealBound({
    rules,
    ...(lease ? { lease } : {}),
    t0: epochAt,
    t1: epochAt + windowMs,
    demand,
    prefix,
  }).admittedCost;
}

function ruleCapacityCost(cell: CellSpec, windowMs: number): number {
  const rules = modelRules(cell);
  const lease = leaseOf(cell);
  const job = cell.workload.job;
  const meanDurationMs =
    job.kind === 'noop' || !job.duration ? 0 : distMean(job.duration);
  if (!rules.length && !lease) return Infinity;
  const meanCost = job.costs
    ? job.costs.values.reduce((s, v, i) => s + v * job.costs!.weights[i]!, 0) /
      job.costs.weights.reduce((s, w) => s + w, 0)
    : 1;
  const copies = independentBudgets(cell) ? cell.workers : 1;
  if (!rules.length)
    return lease && meanDurationMs > 0
      ? copies * (lease.limit / meanDurationMs) * meanCost * windowMs
      : Infinity;
  // Each scoped rule has its own identity count; shared rules remain global.
  const capacityRules = rules.map((r, i) => {
    const scope = cell.rules?.[i]?.scope;
    const identities = scope
      ? cell.workload.job.scopes?.find((s) => s.dimension === scope)?.identities
      : 1;
    return { ...r, limit: r.limit * (identities ?? 1) };
  });
  return (
    copies *
    ruleCapacity(capacityRules, windowMs, {
      ...(lease && meanDurationMs > 0
        ? { lease: { limit: lease.limit, meanDurationMs }, cost: meanCost }
        : {}),
    })
  );
}

/** Synthesize per-job grant events from sync-store call records (keys namespaced per worker). */
export function memoryGrantEvents(
  cell: CellSpec,
  calls: readonly CallRecord[],
): ServerEvent[] {
  const byKey = new Map(
    (cell.rules ?? []).map((r, i) => [
      r.name ? `named:${r.name}` : `${r.algorithm ?? 'gcra'}:${r.intervalMs}`,
      modelRules(cell)[i]!,
    ]),
  );
  const out: ServerEvent[] = [];
  for (const c of calls) {
    if (c.dn === undefined || !c.gc || !c.gk) continue;
    c.gc.forEach((cost, j) => {
      const keys = c.gk![j]!;
      const rules = keys.map((k) => {
        const base = [...byKey.keys()].find(
          (b) => k === b || k.startsWith(`${b}:`),
        );
        const r = base ? byKey.get(base)! : undefined;
        return {
          algorithm: r?.algorithm ?? 'gcra',
          intervalMs: r?.intervalMs ?? 1,
          limit: r?.limit ?? Infinity,
          burst: r?.burst ?? 1,
        };
      });
      out.push({
        op: 'acquire',
        t: c.dn!,
        id: `w${c.w}`,
        ruleKeys: keys.map((k) => `w${c.w}:${k}`),
        rules,
        costs: [cost],
        granted: 1,
        retryAfterMs: 0,
        pausedMs: 0,
      });
    });
  }
  return out;
}

const quantileFrom = (v: number | 'not-reached' | 'failure' | undefined) =>
  typeof v === 'number' ? v : null;

/** Fraction of server admissions inside some client [send, reply] window (clock alignment check). */
export function clockAlignment(
  eventsT: readonly number[],
  calls: readonly CallRecord[],
): number | null {
  if (!eventsT.length || !calls.length) return null;
  const sorted = calls
    .filter((c) => c.op === 'acquire' || c.op === 'scoped')
    .map((c) => [c.t0, c.t1] as const)
    .sort((a, b) => a[0] - b[0]);
  const prefixMax: number[] = [];
  let m = -Infinity;
  for (const [, t1] of sorted) prefixMax.push((m = Math.max(m, t1)));
  let inside = 0;
  for (const t of eventsT) {
    let lo = 0;
    let hi = sorted.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]![0] <= t) {
        idx = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (idx >= 0 && prefixMax[idx]! >= t) inside++;
  }
  return inside / eventsT.length;
}

export function analyzeTrial(d: TrialData): TrialAnalysis {
  const { cell } = d;
  const windowMs = cell.timing.windowMs;
  const a = d.epochAt;
  const b = d.epochAt + windowMs;
  const sec = windowMs / 1000;
  const metrics: MetricMap = {};
  const notes: string[] = [];
  const inWin = (t: number) => t >= a && t < b;

  // Offered demand (schedule, before the system) and capacity quantities.
  const exogenous = demandIsExogenous(cell);
  const open = cell.workload.arrival.kind !== 'backlog' && exogenous;
  const schedule =
    open || cell.workload.deadlines?.urgent ? fleetSchedule(cell, d.seed) : [];
  const offeredCost = schedule.reduce((s, x) => s + x.cost, 0);
  metrics.offeredPerSec = open ? offeredCost / sec : null;
  metrics.offeredJobsPerSec = open ? schedule.length / sec : null;
  const capacity = ruleCapacityCost(cell, windowMs);
  metrics.ruleCapacityPerSec = Number.isFinite(capacity)
    ? capacity / sec
    : null;
  let bound: number | null = null;
  let boundNonPrefix: number | null = null;
  try {
    bound = boundFor(cell, d.seed, true, a);
    boundNonPrefix = cell.workload.job.costs
      ? boundFor(cell, d.seed, false, a)
      : bound;
  } catch (error) {
    notes.push(`ideal bound not computed: ${String(error)}`);
  }
  if (bound === null && exogenous)
    notes.push(
      'ideal bound unavailable: requires known initial state, compatible admission semantics, and complete exogenous demand; no bound ratio is reported',
    );
  else if (bound !== null)
    notes.push(
      'ideal bound: empty initial store state at measurement start; zero latency, not attainable',
    );
  metrics.idealBoundPerSec = bound === null ? null : bound / sec;
  metrics.idealBoundNonPrefixPerSec =
    boundNonPrefix === null ? null : boundNonPrefix / sec;
  if (!exogenous)
    notes.push(
      'finite closed loop: demand depends on the system, so no ideal-bound ratio is reported',
    );

  // Admissions: server log (exact, correctness arms) and client counts (every arm).
  const measured = (d.events ?? []).filter(
    (e) => (e.op === 'acquire' || e.op === 'scoped') && e.id === d.quotaId,
  );
  const loggedGrants = measured.reduce(
    (sum, e) =>
      sum +
      (e.op === 'acquire'
        ? e.granted
        : e.op === 'scoped'
          ? e.grantedIndexes.length
          : 0),
    0,
  );
  const recordedGrants = d.calls
    .filter((c) => (c.op === 'acquire' || c.op === 'scoped') && !c.err)
    .reduce((sum, c) => sum + c.g, 0);
  const observedStarts = d.jobs.filter((j) => j.st >= 0).length;
  const missingLogGrants =
    d.events !== undefined &&
    loggedGrants < Math.max(recordedGrants, observedStarts);
  const restartAuditGap = d.resets.length > 0 && !d.restartAuditComplete;
  const serverLogComplete =
    d.events !== undefined && !missingLogGrants && !restartAuditGap;
  if (missingLogGrants && !restartAuditGap)
    notes.push(
      `server log incomplete: ${loggedGrants} logged grants, ${recordedGrants} client grants, ${observedStarts} callback starts; exact server metrics withheld`,
    );
  let serverCost = 0;
  let serverJobs = 0;
  for (const e of measured) {
    if (!inWin(e.t)) continue;
    if (e.op === 'acquire')
      for (let j = 0; j < e.granted; j++) {
        serverCost += e.costs[j]!;
        serverJobs++;
      }
    else if (e.op === 'scoped')
      for (const i of e.grantedIndexes) {
        serverCost += e.jobs[i]!.cost;
        serverJobs++;
      }
  }
  const acqCalls = d.calls.filter(
    (c) => (c.op === 'acquire' || c.op === 'scoped') && inWin(c.t1),
  );
  const clientGrants = acqCalls.reduce((s, c) => s + c.g, 0);
  const zero = acqCalls.filter((c) => c.g === 0).length;
  const clientCost = acqCalls.every((c) => c.gc !== undefined)
    ? acqCalls.reduce(
        (sum, c) => sum + c.gc!.reduce((s, cost) => s + cost, 0),
        0,
      )
    : !cell.workload.job.costs
      ? clientGrants
      : null;
  metrics.admittedPerSec =
    cell.library !== 'valve'
      ? null
      : serverLogComplete
        ? serverCost / sec
        : d.events
          ? null
          : clientCost === null
            ? null
            : clientCost / sec;
  metrics.clientGrantsPerSec =
    cell.library === 'valve' ? clientGrants / sec : null;
  const started = d.jobs.filter((j) => j.st >= 0 && inWin(j.st));
  const startedCost = started.reduce((s, j) => s + j.c, 0);
  metrics.usefulStartsPerSec = started.length / sec;
  metrics.usefulStartCostPerSec = startedCost / sec;
  metrics.completionsPerSec =
    d.jobs.filter((j) => j.o === Outcome.completed && j.en >= 0 && inWin(j.en))
      .length / sec;
  const admittedCost =
    cell.library !== 'valve'
      ? null
      : d.events
        ? serverLogComplete
          ? serverCost
          : null
        : clientCost;
  metrics.boundEfficiency =
    bound && admittedCost !== null ? admittedCost / bound : null;
  metrics.startBoundEfficiency = bound ? startedCost / bound : null;
  metrics.capacityUtilization =
    Number.isFinite(capacity) && capacity > 0
      ? admittedCost === null
        ? null
        : admittedCost / capacity
      : null;
  metrics.goodput = open && offeredCost > 0 ? startedCost / offeredCost : null;
  metrics.callsPerGrant = clientGrants ? acqCalls.length / clientGrants : null;
  metrics.zeroGrantPerGrant = clientGrants ? zero / clientGrants : null;
  const scripts = d.calls.filter((c) => inWin(c.t1)).length;
  metrics.scriptsPerUsefulJob = started.length
    ? scripts / started.length
    : null;
  const split = serverLogComplete ? classifyZeroGrants(measured) : null;
  metrics.earlyZeroPerGrant =
    split && serverJobs ? split.early / serverJobs : null;
  metrics.lostRacePerGrant =
    split && serverJobs ? split.lostRace / serverJobs : null;
  metrics.clockAlignment = d.events
    ? clockAlignment(
        measured.map((e) => e.t),
        d.calls,
      )
    : null;

  // Redis cost (performance and correctness arms; instrumentation adds an RPUSH per call).
  if (d.info) {
    const grants = d.events
      ? serverLogComplete
        ? serverJobs
        : 0
      : clientGrants;
    metrics.redisCores =
      d.info.wallSec > 0 ? d.info.cpuSec / d.info.wallSec : null;
    metrics.redisCpuUsPerGrant = grants ? (d.info.cpuSec * 1e6) / grants : null;
    metrics.evalshaUsPerCall = d.info.evalshaCalls
      ? d.info.evalshaUsec / d.info.evalshaCalls
      : null;
    metrics.commandsPerSec =
      d.info.wallSec > 0 ? d.info.commands / d.info.wallSec : null;
    metrics.redisUsedMemoryMB = d.info.usedMemory / 2 ** 20;
  }

  // Application resources.
  const live = d.summaries.filter((s) => !s.crashed);
  const appCpuUs = live.reduce((s, x) => s + x.windowCpuUs, 0);
  metrics.appCores = appCpuUs / 1e6 / sec;
  metrics.appCpuUsPerGrant = started.length ? appCpuUs / started.length : null;
  const eld = live
    .map((s) => s.eldP99Ms)
    .filter((x): x is number => x !== null);
  metrics.eldP99Ms = eld.length ? Math.max(...eld) : null;
  metrics.maxRssMB = live.length
    ? Math.max(...live.map((s) => s.maxRssBytes)) / 2 ** 20
    : null;
  metrics.generatorLagP99Ms = live.length
    ? Math.max(...live.map((s) => s.generatorLagP99Ms))
    : null;
  metrics.generatorSaturated = live.some((s) => s.generatorLagMaxMs > 5)
    ? 1
    : 0;
  const depths = live
    .map((s) => s.backlogMinDepth)
    .filter((x): x is number => x !== null);
  metrics.backlogMinDepth = depths.length ? Math.min(...depths) : null;
  if (metrics.generatorSaturated)
    notes.push(
      'generator saturated: submissions lagged intended arrivals by > 5 ms (maximum); open-loop results are invalid',
    );

  // Fairness: equal-demand workers only.
  const perWorker = Array.from({ length: cell.workers }, (_, w) =>
    started.filter((j) => j.w === w),
  );
  const symmetric =
    !d.asymmetric &&
    ['backlog', 'poisson', 'periodic', 'bursty', 'cron', 'ramp'].includes(
      cell.workload.arrival.kind,
    );
  const counts = perWorker.map((l) => l.length);
  metrics.jain =
    symmetric && cell.workers > 1 && counts.some((c) => c > 0)
      ? jain(counts)
      : null;
  const meanShare =
    counts.reduce((s, c) => s + c, 0) / Math.max(1, counts.length);
  metrics.minShare =
    symmetric && meanShare > 0 ? Math.min(...counts) / meanShare : null;
  let maxGap = 0;
  if (symmetric)
    for (const l of perWorker) {
      const ts = l.map((j) => j.st).sort((x, y) => x - y);
      let prev = a;
      for (const t of ts) {
        maxGap = Math.max(maxGap, t - prev);
        prev = t;
      }
      maxGap = Math.max(maxGap, b - prev);
    }
  metrics.maxNoStartGapMs = symmetric ? maxGap : null;

  // Pacing as observed by clients (contract metric for L2/D2, never a Valve safety check).
  const starts = d.jobs
    .filter((j) => j.st >= 0)
    .map((j) => j.st)
    .sort((x, y) => x - y);
  let minGap = Infinity;
  for (let i = 1; i < starts.length; i++)
    minGap = Math.min(minGap, starts[i]! - starts[i - 1]!);
  metrics.minStartGapMs = Number.isFinite(minGap) ? minGap : null;
  const rule = cell.rules?.[0];
  if (rule) {
    let lo = 0;
    let max = 0;
    for (let hi = 0; hi < starts.length; hi++) {
      while (starts[hi]! - starts[lo]! >= rule.intervalMs) lo++;
      max = Math.max(max, hi - lo + 1);
    }
    metrics.maxStartsPerInterval = max;
  }

  // Outcomes per cohort and latency views (counts always alongside latency).
  const outcomes: Record<string, Record<string, number>> = {};
  const byCohort = new Map<number, JobRecord[]>();
  for (const j of d.jobs)
    if (inWin(j.ia))
      (byCohort.get(j.k) ?? byCohort.set(j.k, []).get(j.k)!).push(j);
  for (const [k, list] of byCohort) {
    const name = COHORTS[k] ?? `cohort${k}`;
    const o: Record<string, number> = { submitted: list.length };
    for (const j of list)
      o[OUTCOME_NAMES[j.o]!] = (o[OUTCOME_NAMES[j.o]!] ?? 0) + 1;
    outcomes[name] = o;
    const recs: StartTimeRecord[] = list
      .filter((j) => j.o !== Outcome.pending || j.st >= 0)
      .map((j) => {
        if (j.st >= 0) return { wait: j.st - j.ia, outcome: 'started' };
        const observationEnd = b + cell.timing.drainMs;
        const t =
          (j.o === Outcome.aborted && j.ab >= 0
            ? j.ab
            : j.en >= 0
              ? j.en
              : observationEnd) - j.ia;
        const outcome =
          j.o === Outcome.expired
            ? 'expired'
            : j.o === Outcome.rejected
              ? 'rejected'
              : j.o === Outcome.aborted
                ? 'aborted'
                : 'unserved';
        return { wait: Math.max(0, t), outcome };
      });
    if (!recs.length) continue;
    const s = startTimeSummary(recs, [0.5, 0.95, 0.99, 0.999]);
    metrics[`${name}.waitP50`] = s.conditional.p50 ?? null;
    metrics[`${name}.waitP95`] = s.conditional.p95 ?? null;
    metrics[`${name}.waitP99`] = s.conditional.p99 ?? null;
    metrics[`${name}.waitP999`] = s.conditional['p99.9'] ?? null;
    metrics[`${name}.cifP50`] = quantileFrom(s.cif.p50);
    metrics[`${name}.cifP99`] = quantileFrom(s.cif.p99);
    metrics[`${name}.cifMaxStart`] = s.cifMaxStart;
    metrics[`${name}.failureRankedP99`] = quantileFrom(s.failureRanked.p99);
    const withDeadline = list.filter((j) => j.mw >= 0);
    if (withDeadline.length)
      metrics[`${name}.deadlineSuccess`] =
        withDeadline.filter((j) => j.st >= 0 && j.st - j.sa <= j.mw).length /
        withDeadline.length;
  }
  const deadlined = d.jobs.filter((j) => inWin(j.ia) && j.mw >= 0);
  metrics.deadlineSuccess = deadlined.length
    ? deadlined.filter((j) => j.st >= 0 && j.st - j.sa <= j.mw).length /
      deadlined.length
    : null;

  // Chaos: throughput recovery after each fault (start rate back to 90% of the pre-fault rate).
  const firedFaults = (d.faultLog ?? []).filter((f) => !f.error);
  if (firedFaults.length) {
    const allStarts = d.jobs.filter((j) => j.st >= 0).map((j) => j.st);
    let worst: number | null = 0;
    let dipRatio = 1;
    for (const f of firedFaults) {
      const r = recoveryMs(
        allStarts,
        { from: a, to: b },
        { at: a + f.firedAtMs, doneAt: a + (f.doneAtMs ?? f.firedAtMs) },
      );
      worst =
        worst === null || r.recoveryMs === null
          ? null
          : Math.max(worst, r.recoveryMs);
      if (r.preRatePerSec > 0)
        dipRatio = Math.min(dipRatio, r.dipRatePerSec / r.preRatePerSec);
    }
    metrics.recoveryMs = worst;
    metrics.faultDipRatio = dipRatio;
    if (worst === null)
      notes.push(
        'throughput did not recover to 90% of the pre-fault rate within the window',
      );
  }
  // Soak: leak slopes (MB/hour) with t-intervals; suspected when the lower bound exceeds 5 MB/h.
  if (d.samples?.length) {
    let worstHeap: ReturnType<typeof slope> = null;
    let worstRss: ReturnType<typeof slope> = null;
    for (const w of new Set(d.samples.map((x) => x.w))) {
      const pts = d.samples.filter(
        (x) => x.w === w && x.t >= a + Math.min(windowMs * 0.2, 60000),
      );
      const h = slope(pts.map((x) => ({ t: x.t, y: x.heap / 2 ** 20 })));
      const r = slope(pts.map((x) => ({ t: x.t, y: x.rss / 2 ** 20 })));
      if (h && (!worstHeap || h.lo > worstHeap.lo)) worstHeap = h;
      if (r && (!worstRss || r.lo > worstRss.lo)) worstRss = r;
    }
    metrics.heapSlopeMBPerHour = worstHeap?.slopePerHour ?? null;
    metrics.heapSlopeLoMBPerHour = worstHeap?.lo ?? null;
    metrics.rssSlopeMBPerHour = worstRss?.slopePerHour ?? null;
    metrics.heapLeakSuspected =
      leakVerdict(worstHeap, 5) === 'LEAK SUSPECTED' ? 1 : 0;
    notes.push(
      `heap: ${leakVerdict(worstHeap, 5)} (worst worker slope ${worstHeap ? worstHeap.slopePerHour.toFixed(2) : '?'} MB/h, CI ${worstHeap ? `${worstHeap.lo.toFixed(2)}…${worstHeap.hi.toFixed(2)}` : '?'})`,
    );
  }
  if (d.redisSamples && d.redisSamples.length >= 3) {
    const m = slope(
      d.redisSamples.map((x) => ({ t: x.t, y: x.usedMemory / 2 ** 20 })),
    );
    const k = slope(d.redisSamples.map((x) => ({ t: x.t, y: x.keys })));
    metrics.redisMemSlopeMBPerHour = m?.slopePerHour ?? null;
    metrics.redisKeysSlopePerHour = k?.slopePerHour ?? null;
    metrics.redisKeysEnd = d.redisSamples.at(-1)!.keys;
  }

  // Safety: client oracles in every arm, server oracles when the log exists.
  const violations: Violation[] = [];
  if (missingLogGrants && !restartAuditGap)
    violations.push({
      class: 'reconciliation',
      detail: `incomplete server log: ${loggedGrants} grants vs ${recordedGrants} client grants and ${observedStarts} starts`,
    });
  const checked: ViolationClass[] = [
    'start-after-abort',
    'maxwait-C1-check-before-deadline',
    'maxwait-late-grant',
    'lost-job',
    'worker-crash',
  ];
  const unverified: ViolationClass[] = [];
  if (restartAuditGap) {
    unverified.push('reconciliation');
    notes.push(
      'Redis restart lacks a complete external Lua audit checkpoint; pre-reset server safety and exact grant metrics are unverified.',
    );
  } else if (d.resets.length)
    notes.push(
      'Planned restart audit: atomically captured Lua logs outside Redis and paused writes until state loss; safety is checked separately across each reset. This does not cover an unannounced crash.',
    );
  const lease = leaseOf(cell);
  const localConcurrency =
    cell.library === 'identity'
      ? undefined
      : typeof cell.concurrency === 'number'
        ? cell.concurrency
        : cell.concurrency?.scope === 'local'
          ? cell.concurrency.limit
          : undefined;
  const client = checkClient(d.jobs, {
    killedWorkers: d.killedWorkers,
    ...(lease ? { fleetConcurrency: lease.limit } : {}),
    ...(localConcurrency !== undefined ? { localConcurrency } : {}),
  });
  violations.push(...client.violations);
  const comparator = competitorContract(cell, d.jobs);
  violations.push(...comparator.violations);
  unverified.push(...comparator.unverified);
  notes.push(...comparator.notes);
  if (localConcurrency !== undefined) checked.push('contract');
  metrics.clientMaxOverlap = client.maxOverlapFleet;
  metrics.worstLateMs = client.worstLateMs;
  metrics.lateByValveClock = client.lateByValveClock;
  for (const s of d.summaries)
    if (s.crashed && !d.killedWorkers.has(s.worker))
      violations.push({
        class: 'worker-crash',
        detail: `worker ${s.worker} crashed`,
        worker: s.worker,
      });
  const hasRules = !!cell.rules?.length;
  // Memory store cells: replay each worker's independent store from recorded Date.now() decisions.
  const memoryEvents =
    !d.events &&
    cell.library === 'valve' &&
    cell.store.kind === 'memory' &&
    hasRules
      ? memoryGrantEvents(cell, d.calls)
      : undefined;
  if (memoryEvents) {
    violations.push(...checkRates(memoryEvents).violations);
    checked.push('rate-bound', 'window-bound', 'scoped-bound');
  }
  if (d.events) {
    checked.push('reconciliation');
    if (!serverLogComplete)
      unverified.push(
        'rate-bound',
        'window-bound',
        'scoped-bound',
        'lease-oversubscription',
      );
    const rates = checkRates(d.events, d.resets);
    violations.push(...rates.violations);
    const leases = checkLeases(d.events, d.resets);
    violations.push(...leases.violations);
    metrics.leaseMaxOccupancy = lease ? leases.maxOccupancy : null;
    checked.push(
      'rate-bound',
      'window-bound',
      'scoped-bound',
      'lease-oversubscription',
    );
    const wasted = serverJobs
      ? Math.max(0, serverJobs - started.length) / serverJobs
      : null;
    metrics.wastedGrantFraction = wasted;
  } else if (cell.library === 'valve' && cell.store.kind === 'redis') {
    if (hasRules) unverified.push('rate-bound', 'window-bound', 'scoped-bound');
    if (lease && !d.resets.length && !d.killedWorkers.size)
      checked.push('lease-oversubscription');
  } else if (lease && !d.resets.length && !d.killedWorkers.size)
    checked.push('lease-oversubscription');
  if (lease && (d.resets.length || d.killedWorkers.size) && !d.events)
    unverified.push('lease-oversubscription');
  return {
    metrics,
    outcomes,
    safety: safetyReport(violations, checked, unverified),
    notes,
  };
}
