// Shared contracts between planning, workers, oracles, analysis, and reports.
// Times: `*Ms` are durations in milliseconds; `*At` are epoch milliseconds from
// performance.timeOrigin + performance.now() (same-host, cross-process comparable).

/** A probability distribution over non-negative milliseconds. */
export type DistSpec =
  | { kind: 'fixed'; ms: number }
  | { kind: 'exp'; meanMs: number }
  | { kind: 'uniform'; minMs: number; maxMs: number }
  | { kind: 'lognormal'; medianMs: number; sigma: number }
  | { kind: 'normal'; meanMs: number; sdMs: number }
  | { kind: 'mixed'; parts: { weight: number; dist: DistSpec }[] };

/** One rate rule as Valve accepts it (intervalMs instead of Duration strings). */
export interface RuleSpec {
  name?: string;
  scope?: string;
  limit: number;
  intervalMs: number;
  burst?: number;
  algorithm?: 'gcra' | 'fixed-window';
}

/** Valve concurrency, or a competitor's concurrency limit. */
export type ConcurrencySpec =
  number | { limit: number; scope: 'local' | 'global'; leaseTtlMs?: number };

/**
 * Offered demand. Open-loop kinds are fleet-wide rates split across workers and
 * precomputed from the seed before the run; they never react to the system.
 */
export type ArrivalSpec =
  /** Saturated closed loop: each worker maintains `depth` waiting jobs. */
  | { kind: 'backlog'; depth: number }
  /** Finite closed loop: `clients` issuers per worker, each submits after the previous settles plus think time. Demand is endogenous. */
  | { kind: 'clients'; clients: number; think: DistSpec }
  | { kind: 'poisson'; ratePerSec: number }
  /** Constant spacing with a random phase per worker. */
  | { kind: 'periodic'; ratePerSec: number }
  /** Poisson during `onMs`, silent during `offMs`, repeating. */
  | { kind: 'bursty'; ratePerSec: number; onMs: number; offMs: number }
  /** Every `everyMs`, each worker submits `perWorker` jobs within `spreadMs` (cron-synchronized surge). */
  | { kind: 'cron'; everyMs: number; perWorker: number; spreadMs: number }
  /** Poisson whose rate ramps linearly over the measured window. */
  | { kind: 'ramp'; fromPerSec: number; toPerSec: number }
  /** A fraction of workers carries `heavyShare` of a Poisson fleet rate. */
  | {
      kind: 'uneven';
      ratePerSec: number;
      heavyWorkers: number;
      heavyShare: number;
    };

export interface ScopeMixSpec {
  /** Scope dimension name used by scoped rules. */
  dimension: string;
  /** Number of distinct identities. */
  identities: number;
  /** Zipf exponent; 0 = uniform. */
  skew?: number;
}

export interface JobSpec {
  /** `noop` returns immediately; `async` awaits a timer; `sync` busy-spins the CPU. */
  kind: 'noop' | 'async' | 'sync';
  duration?: DistSpec;
  /** Weighted cost mix. Default cost 1. */
  costs?: { values: number[]; weights: number[] };
  scopes?: ScopeMixSpec[];
  /** Fraction of jobs that throw (exercises failure accounting). */
  failRate?: number;
}

export interface DeadlineSpec {
  /** maxWait applied to a fraction of ordinary jobs. */
  maxWaitMs?: number;
  fraction?: number;
  /** Separate open-loop cohort of urgent jobs. */
  urgent?: { ratePerSec: number; maxWaitMs: number; priority: number };
}

export interface AbortSpec {
  /** Shared comparator contract: do not abort an already-running callback. */
  queuedOnly?: boolean;
  /** Fraction of jobs given an AbortSignal. */
  fraction: number;
  /** Delay after submission at which the signal aborts. */
  after: DistSpec;
}

export interface RuntimeSpec {
  /** Background setInterval period in each worker (event-loop activity). */
  bgTimerMs?: number;
  /** Busy work per background tick. */
  bgWorkMs?: number;
  /** Event-loop delay sampler resolution; 0 disables. Default 10 (1 ms perturbs results). */
  eldResolutionMs?: number;
  /** Soak: sample heap/RSS/progress every N ms (leak and drift detection). */
  sampleEveryMs?: number;
}

export interface WorkloadSpec {
  arrival: ArrivalSpec;
  job: JobSpec;
  deadlines?: DeadlineSpec;
  abort?: AbortSpec;
  runtime?: RuntimeSpec;
}

export type StoreSpec =
  | { kind: 'memory' }
  | {
      kind: 'redis';
      /** Infra server name, e.g. `redis74`, `valkey8`, `redis74-netem`. */
      server: string;
      /** Valve: attach a separate subscriber connection (lease release notices). */
      subscriber?: boolean;
    };

export interface NetworkSpec {
  delayMs: number;
  jitterMs: number;
  lossPct?: number;
  distribution?: 'normal' | 'pareto' | 'paretonormal';
}

export type FaultSpec = { atMs: number } & (
  | { type: 'kill-workers'; workers: number[] }
  | { type: 'spawn-workers'; count: number }
  | { type: 'redis-restart' }
  | { type: 'redis-pause'; ms: number }
  | { type: 'client-kill' }
  | { type: 'redis-stall'; ms: number }
  | { type: 'redis-cpu'; duty: number; forMs: number }
  | { type: 'redis-load'; opsPerSec: number; forMs: number }
);

export type LibraryId =
  'valve' | 'p-limit' | 'p-queue' | 'bottleneck' | 'identity';

export type Mechanism =
  | 'gcra'
  | 'fixed-window'
  | 'multi-rule'
  | 'scoped'
  | 'weighted'
  | 'lease'
  | 'combined'
  | 'local-concurrency'
  | 'pacing'
  | 'window'
  | 'burst-bank'
  | 'cancellation';

export interface TimingSpec {
  /** Warmup on a separate budget (separate id), excluded from measurement. */
  warmupMs: number;
  /** Measured window, starting at the shared epoch. */
  windowMs: number;
  /** After the window, follow outstanding jobs to a terminal outcome for at most this long. */
  drainMs: number;
}

export interface CellSpec {
  /** Valve public execution seam. Alternate seams use simple unweighted jobs. */
  apiMode?: 'run' | 'wrap' | 'wrapFetch';
  /** Shared pause/feedback lifecycle exercises, issued by the named worker. */
  controls?: {
    atMs: number;
    worker: number;
    action: 'pause' | 'resume' | 'observe';
    durationMs?: number;
  }[];
  /** Stable id `suite/name`. */
  id: string;
  suite: string;
  /** Competitor category id (L1..L5, D1..D3) when this is a library comparison cell. */
  category?: string;
  library: LibraryId;
  mechanism: Mechanism;
  workers: number;
  /** Valve instances per worker process sharing one id. Default 1. */
  instances?: number;
  rules?: RuleSpec[];
  concurrency?: ConcurrencySpec;
  batch?: number;
  maxQueue?: number;
  store: StoreSpec;
  network?: NetworkSpec;
  workload: WorkloadSpec;
  timing: TimingSpec;
  faults?: FaultSpec[];
  /** Lower runs first when budgets truncate. 0 = mandatory risk cell. */
  priority: number;
  tags: string[];
  /** Notes printed in reports (e.g. why a bound is approximate). */
  notes?: string[];
}

/** Content identity of a Valve build artifact. */
export interface BuildIdentity {
  /** Short label, e.g. `current`, `master`, `ref:abc123`, `patch:…`. */
  label: string;
  gitSha: string;
  dirty: boolean;
  diffSha256?: string;
  patchSha256?: string;
  /** Absolute path of the frozen Valve package, including dist and matching source. */
  packageDir: string;
  /** SHA-256 over sorted `dist/` file hashes. */
  distSha256: string;
  files: Record<string, string>;
  /** Optional only for manifests written before source footprint measurements existed. */
  sourceFiles?: Record<string, string>;
  sourceSha256?: string;
  lockSha256: string;
  luaSha1: Record<string, string>;
  builtAt: string;
  node: string;
}

export interface ArmSpec {
  /** `base`, `head`, `aa` (same artifact as base, separate processes), or a candidate name. */
  name: string;
  build: BuildIdentity;
  /** `correctness` swaps in instrumented Lua that logs every script call server-side. */
  instrument: 'none' | 'correctness';
}

/** Outcome codes recorded per job. */
export const Outcome = {
  pending: 0,
  completed: 1,
  failed: 2,
  expired: 3,
  aborted: 4,
  rejected: 5,
  /** Still queued when observation ended (right-censored). */
  unserved: 6,
} as const;
export type OutcomeCode = (typeof Outcome)[keyof typeof Outcome];

/** Job cohorts. */
export const Cohort = {
  backlog: 0,
  open: 1,
  urgent: 2,
  client: 3,
} as const;

/** One job, as written by a worker (compact keys keep NDJSON small). */
export interface JobRecord {
  /** worker index */
  w: number;
  /** job sequence within the worker */
  i: number;
  /** cohort */
  k: number;
  /** intended arrival (offered schedule), epoch ms; equals sa for closed-loop */
  ia: number;
  /** actual submit, epoch ms */
  sa: number;
  /** callback start, epoch ms, or -1 */
  st: number;
  /** Callback-body settlement (before limiter bookkeeping), or terminal rejection/censor time; epoch ms, or -1. */
  en: number;
  /** terminal outcome */
  o: OutcomeCode;
  /** cost */
  c: number;
  /** maxWait ms, or -1 */
  mw: number;
  /** abort fired at, epoch ms, or -1 */
  ab: number;
  /** reply time of the store call that preceded the callback start, epoch ms, or -1 */
  rp: number;
  /** Date.now() at submit and at start (Valve's own clock) */
  sd: number;
  sdStart: number;
  /** rejection code for o=rejected */
  code?: string;
  /** scope identity key (scoped cells) */
  sc?: string;
}

/** One store call observed by the client instrument. */
export interface CallRecord {
  w: number;
  /** acquire | scoped | release | renew | pause | resume */
  op: string;
  /** send and reply, epoch ms */
  t0: number;
  t1: number;
  /** jobs granted / requested */
  g: number;
  n: number;
  /** retry hint ms */
  ra: number;
  /** lease blocked */
  lb?: boolean;
  err?: string;
  /** Sync stores: Date.now() used by the store. All Valve stores record granted costs. */
  dn?: number;
  gc?: number[];
  gk?: string[][];
}

/** Per-worker end-of-run summary. */
export interface WorkerSummary {
  worker: number;
  pid: number;
  submitted: number;
  /** p99 / max lag of actual submission behind intended arrival, ms. */
  generatorLagP99Ms: number;
  generatorLagMaxMs: number;
  backlogMinDepth: number | null;
  windowCpuUs: number;
  eldP50Ms: number | null;
  eldP99Ms: number | null;
  eldMaxMs: number | null;
  maxRssBytes: number;
  heapUsedBytes: number;
  totals: Record<string, number>;
  errors: Record<string, number>;
  crashed?: boolean;
  /** Wall vs monotonic drift over the run. */
  clockDriftMs: number;
}

/** Server-side event decoded from instrumented Lua logs. */
export type ServerEvent =
  | {
      op: 'acquire';
      /** Redis TIME, ms (fractional) */
      t: number;
      id: string;
      /** rule keys in request order (full Redis keys) */
      ruleKeys: string[];
      rules: {
        algorithm: 'gcra' | 'fixed-window';
        intervalMs: number;
        limit: number;
        burst: number;
      }[];
      costs: number[];
      granted: number;
      retryAfterMs: number;
      pausedMs: number;
      lease?: {
        limit: number;
        ttlMs: number;
        owner: string;
        tokens: string[];
        blocked: boolean;
      };
    }
  | {
      op: 'scoped';
      t: number;
      id: string;
      ruleKeys: string[];
      rules: {
        algorithm: 'gcra' | 'fixed-window';
        intervalMs: number;
        limit: number;
        burst: number;
      }[];
      jobs: { cost: number; refs: number[] }[];
      grantedIndexes: number[];
      blocked: {
        index: number;
        retryAfterMs: number;
        leaseBlocked?: boolean;
      }[];
      pausedMs: number;
      lease?: {
        limit: number;
        ttlMs: number;
        owner: string;
        tokens: { index: number; token: string }[];
      };
    }
  | { op: 'release'; t: number; leaseKey: string; tokens: string[] }
  | {
      op: 'renew';
      t: number;
      leaseKey: string;
      ttlMs: number;
      tokens: string[];
      valid: boolean;
    };

export type ViolationClass =
  | 'rate-bound'
  | 'window-bound'
  | 'scoped-bound'
  | 'lease-oversubscription'
  | 'start-after-abort'
  | 'maxwait-C1-check-before-deadline'
  | 'maxwait-late-grant'
  | 'lost-job'
  | 'worker-crash'
  | 'contract'
  | 'reconciliation';

export interface Violation {
  class: ViolationClass;
  detail: string;
  /** Magnitude in the class's unit (ms early/late, units over, slots over). */
  magnitude?: number;
  at?: number;
  worker?: number;
}

export type SafetyStatus = 'PASS' | 'FAIL' | 'UNVERIFIED';

export interface SafetyReport {
  status: SafetyStatus;
  /** Which checks ran; missing checks make an otherwise clean report UNVERIFIED for that class. */
  checked: ViolationClass[];
  unverified: ViolationClass[];
  counts: Partial<Record<ViolationClass, number>>;
  /** First N violations for diagnosis. */
  samples: Violation[];
}

/** Resource validity of one trial (authoritative runs only reject; portable runs annotate). */
export interface ResourceReport {
  valid: boolean;
  authoritative: boolean;
  reasons: string[];
  [key: string]: unknown;
}

/** Scalar metrics of one trial window; null when not applicable or not measurable. */
export type MetricMap = Record<string, number | null>;

export interface TrialRecord {
  notes?: string[];
  runId: string;
  trialId: string;
  cellId: string;
  cellHash: string;
  arm: string;
  rep: number;
  seed: number;
  attempt: number;
  fingerprintId: string;
  buildDistSha256: string;
  startedAt: string;
  durationSec: number;
  status: 'ok' | 'failed' | 'resource-invalid' | 'aborted';
  error?: string;
  metrics: MetricMap;
  /** Outcome counts per cohort. */
  outcomes: Record<string, Record<string, number>>;
  safety: SafetyReport;
  resources: ResourceReport;
  /** Relative path of the gzip payload with raw records. */
  payload?: string;
}

/** Performance verdict per metric and cell. */
export type PerfVerdict =
  | 'REGRESSION'
  | 'IMPROVEMENT'
  | 'NONINFERIOR'
  | 'EQUIVALENT'
  | 'INCONCLUSIVE'
  | 'UNSTABLE'
  | 'DESCRIPTIVE';

/** Preregistered metric for decisions. */
export interface DecisionMetric {
  metric: string;
  /** Direction in which the metric is better. */
  better: 'higher' | 'lower';
  /** Absolute margin in metric units, or relative (fraction of base mean) when `relative` is true. */
  margin: number;
  relative?: boolean;
  /** Absolute floor for relative margins. */
  minMargin?: number;
}

export interface DecisionPlan {
  metrics: DecisionMetric[];
  /** Preregistered looks (cumulative reps). */
  looks: number[];
  /** Two-sided family alpha across looks (Bonferroni split). */
  alpha: number;
}
