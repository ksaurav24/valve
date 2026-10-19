// Mechanism-specific suites. Each suite declares smoke cells (fast correctness), risk cells
// (conditions that reversed earlier conclusions, priority 0) and optional covering factors.
// Cells are plain data; their hash identifies them in manifests and resumption.
import type {
  CellSpec,
  DecisionMetric,
  NetworkSpec,
  RuleSpec,
  StoreSpec,
  WorkloadSpec,
} from '../core/types.ts';
import { pairwise, type Factors, type Row } from './covering.ts';

export type Scale = 'smoke' | 'matrix';

export interface SuiteDef {
  name: string;
  title: string;
  /** Needs a Redis-compatible server (redis74/valkey8/…). */
  redis: boolean;
  /** Needs a netem-capable server. */
  netem?: boolean;
  /** Needs container control (faults). */
  faults?: boolean;
  smoke(store: string): CellSpec[];
  risk(store: string): CellSpec[];
  covering?: { factors: Factors; build(row: Row, store: string): CellSpec };
  /** Preregistered decision metrics (only those present in a cell's metrics are evaluated). */
  decision: DecisionMetric[];
}

const redis = (server: string, subscriber = false): StoreSpec => ({
  kind: 'redis',
  server,
  ...(subscriber ? { subscriber } : {}),
});

/** Smallest valid window: at least 40 eligibility slots of the slowest binding rule, and ≥ min. */
export function windowFor(
  rules: readonly RuleSpec[] | undefined,
  scale: Scale,
): number {
  const min = scale === 'smoke' ? 1500 : 4000;
  if (!rules?.length) return min;
  const slot = Math.max(...rules.map((r) => r.intervalMs / r.limit));
  return Math.max(min, Math.ceil(slot * 40));
}

function make(
  scale: Scale,
  partial: Omit<CellSpec, 'timing' | 'priority' | 'tags' | 'library'> &
    Partial<Pick<CellSpec, 'timing' | 'priority' | 'tags' | 'library'>>,
): CellSpec {
  return {
    library: 'valve',
    priority: 1,
    tags: [],
    timing:
      scale === 'smoke'
        ? {
            warmupMs: 300,
            windowMs: windowFor(partial.rules, scale),
            drainMs: 600,
          }
        : {
            warmupMs: 1000,
            windowMs: windowFor(partial.rules, scale),
            drainMs: 1500,
          },
    ...partial,
  };
}

const backlog = (
  depth = 128,
  job: WorkloadSpec['job'] = { kind: 'noop' },
): WorkloadSpec => ({ arrival: { kind: 'backlog', depth }, job });
const poisson = (
  ratePerSec: number,
  job: WorkloadSpec['job'] = { kind: 'noop' },
): WorkloadSpec => ({ arrival: { kind: 'poisson', ratePerSec }, job });
const gcra = (limit: number, burst = 1, intervalMs = 1000): RuleSpec => ({
  limit,
  intervalMs,
  burst,
});

const RATE_METRICS: DecisionMetric[] = [
  { metric: 'capacityUtilization', better: 'higher', margin: 0.01 },
  {
    metric: 'callsPerGrant',
    better: 'lower',
    margin: 0.05,
    relative: true,
    minMargin: 0.02,
  },
  {
    metric: 'redisCpuUsPerGrant',
    better: 'lower',
    margin: 0.1,
    relative: true,
    minMargin: 2,
  },
  {
    metric: 'open.cifP99',
    better: 'lower',
    margin: 0.1,
    relative: true,
    minMargin: 5,
  },
  { metric: 'urgent.deadlineSuccess', better: 'higher', margin: 0.02 },
  { metric: 'jain', better: 'higher', margin: 0.02 },
  {
    metric: 'appCpuUsPerGrant',
    better: 'lower',
    margin: 0.1,
    relative: true,
    minMargin: 5,
  },
];

const gcraSuite: SuiteDef = {
  name: 'gcra',
  title: 'GCRA rates and bursts across worker counts',
  redis: true,
  smoke: (s) => [
    make('smoke', {
      id: 'gcra/smoke-1w-100-b1',
      suite: 'gcra',
      mechanism: 'gcra',
      workers: 1,
      rules: [gcra(100)],
      concurrency: 16,
      store: redis(s),
      workload: backlog(32),
    }),
    make('smoke', {
      id: 'gcra/smoke-4w-500-b10',
      suite: 'gcra',
      mechanism: 'gcra',
      workers: 4,
      rules: [gcra(500, 10)],
      concurrency: 16,
      store: redis(s),
      workload: backlog(64),
    }),
    make('smoke', {
      id: 'gcra/smoke-4w-poisson',
      suite: 'gcra',
      mechanism: 'gcra',
      workers: 4,
      rules: [gcra(400)],
      concurrency: 16,
      store: redis(s),
      workload: poisson(280, {
        kind: 'async',
        duration: { kind: 'exp', meanMs: 5 },
      }),
    }),
    make('smoke', {
      id: 'gcra/smoke-memory-2w',
      suite: 'gcra',
      mechanism: 'gcra',
      workers: 2,
      rules: [gcra(200, 5)],
      concurrency: 16,
      store: { kind: 'memory' },
      workload: backlog(32),
    }),
  ],
  risk: (s) => [
    ...[
      [32, 500],
      [32, 1000],
      [64, 500],
      [16, 2000],
      [1, 100],
      [8, 10],
      [4, 500],
      [8, 333],
    ].map(([w, q]) =>
      make('matrix', {
        id: `gcra/sat-${w}w-${q}-b1`,
        suite: 'gcra',
        mechanism: 'gcra',
        workers: w!,
        rules: [gcra(q!)],
        concurrency: 16,
        store: redis(s),
        workload: backlog(128),
        priority: 0,
        tags: ['risk', 'saturated'],
      }),
    ),
    make('matrix', {
      id: 'gcra/sat-32w-500-b10',
      suite: 'gcra',
      mechanism: 'gcra',
      workers: 32,
      rules: [gcra(500, 10)],
      concurrency: 16,
      store: redis(s),
      workload: backlog(128),
      priority: 1,
      tags: ['burst'],
    }),
    make('matrix', {
      id: 'gcra/sat-32w-500-b100',
      suite: 'gcra',
      mechanism: 'gcra',
      workers: 32,
      rules: [gcra(500, 100)],
      concurrency: 16,
      store: redis(s),
      workload: backlog(128),
      priority: 1,
      tags: ['burst'],
    }),
    make('matrix', {
      id: 'gcra/poisson-32w-500-0.7',
      suite: 'gcra',
      mechanism: 'gcra',
      workers: 32,
      rules: [gcra(500)],
      concurrency: 16,
      store: redis(s),
      workload: poisson(350, {
        kind: 'async',
        duration: { kind: 'exp', meanMs: 20 },
      }),
      priority: 0,
      tags: ['risk', 'open-loop'],
    }),
    make('matrix', {
      id: 'gcra/poisson-8w-500-0.95',
      suite: 'gcra',
      mechanism: 'gcra',
      workers: 8,
      rules: [gcra(500)],
      concurrency: 16,
      store: redis(s),
      workload: poisson(475),
      priority: 0,
      tags: ['risk', 'near-capacity'],
    }),
    make('matrix', {
      id: 'gcra/cron-16w-500',
      suite: 'gcra',
      mechanism: 'gcra',
      workers: 16,
      rules: [gcra(500, 10)],
      concurrency: 16,
      store: redis(s),
      workload: {
        arrival: { kind: 'cron', everyMs: 1000, perWorker: 40, spreadMs: 20 },
        job: { kind: 'async', duration: { kind: 'fixed', ms: 10 } },
      },
      priority: 1,
      tags: ['surge'],
    }),
    make('matrix', {
      id: 'gcra/uneven-8w-500',
      suite: 'gcra',
      mechanism: 'gcra',
      workers: 8,
      rules: [gcra(500)],
      concurrency: 16,
      store: redis(s),
      workload: {
        arrival: {
          kind: 'uneven',
          ratePerSec: 600,
          heavyWorkers: 2,
          heavyShare: 0.8,
        },
        job: { kind: 'noop' },
      },
      priority: 0,
      tags: ['risk', 'uneven'],
    }),
    make('matrix', {
      id: 'gcra/bursty-16w-500-idle',
      suite: 'gcra',
      mechanism: 'gcra',
      workers: 16,
      rules: [gcra(500, 50)],
      concurrency: 16,
      store: redis(s),
      workload: {
        arrival: { kind: 'bursty', ratePerSec: 1500, onMs: 300, offMs: 700 },
        job: { kind: 'noop' },
      },
      priority: 1,
      tags: ['idle-to-active'],
    }),
    make('matrix', {
      id: 'gcra/clients-16w-500',
      suite: 'gcra',
      mechanism: 'gcra',
      workers: 16,
      rules: [gcra(500)],
      concurrency: 16,
      store: redis(s),
      workload: {
        arrival: {
          kind: 'clients',
          clients: 4,
          think: { kind: 'exp', meanMs: 20 },
        },
        job: { kind: 'async', duration: { kind: 'exp', meanMs: 10 } },
      },
      priority: 2,
      tags: ['closed-loop'],
      notes: ['finite closed loop: no ideal-bound ratio'],
    }),
  ],
  covering: {
    factors: {
      workers: [1, 4, 16, 32, 64],
      quota: [10, 100, 500, 1000, 2000],
      burst: [1, 10, 100],
      arrival: ['backlog', 'poisson0.7', 'cron'],
      runtime: ['idle', 'bgloop'],
      job: ['noop', 'async5', 'sync0.5'],
    },
    build(row, s) {
      const q = Number(row.quota);
      const job: WorkloadSpec['job'] =
        row.job === 'noop'
          ? { kind: 'noop' }
          : row.job === 'async5'
            ? { kind: 'async', duration: { kind: 'fixed', ms: 5 } }
            : { kind: 'sync', duration: { kind: 'fixed', ms: 0.5 } };
      const arrival: WorkloadSpec['arrival'] =
        row.arrival === 'backlog'
          ? { kind: 'backlog', depth: 128 }
          : row.arrival === 'cron'
            ? {
                kind: 'cron',
                everyMs: 1000,
                perWorker: Math.max(
                  2,
                  Math.round((q * 0.8) / Number(row.workers)),
                ),
                spreadMs: 20,
              }
            : { kind: 'poisson', ratePerSec: q * 0.7 };
      return make('matrix', {
        id: `gcra/cov-${row.workers}w-${q}-b${row.burst}-${row.arrival}-${row.runtime}-${row.job}`,
        suite: 'gcra',
        mechanism: 'gcra',
        workers: Number(row.workers),
        rules: [gcra(q, Number(row.burst))],
        concurrency: 16,
        store: redis(s),
        workload: {
          arrival,
          job,
          ...(row.runtime === 'bgloop'
            ? { runtime: { bgTimerMs: 1, bgWorkMs: 0.05 } }
            : {}),
        },
        priority: 3,
        tags: ['covering'],
      });
    },
  },
  decision: RATE_METRICS,
};

const fixedSuite: SuiteDef = {
  name: 'fixed-window',
  title: 'Aligned fixed windows and boundary bursts',
  redis: true,
  smoke: (s) => [
    make('smoke', {
      id: 'fixed/smoke-4w-200',
      suite: 'fixed-window',
      mechanism: 'fixed-window',
      workers: 4,
      rules: [{ limit: 100, intervalMs: 500, algorithm: 'fixed-window' }],
      concurrency: 16,
      store: redis(s),
      workload: backlog(64),
    }),
    make('smoke', {
      id: 'fixed/smoke-memory-1w',
      suite: 'fixed-window',
      mechanism: 'fixed-window',
      workers: 1,
      rules: [{ limit: 50, intervalMs: 250, algorithm: 'fixed-window' }],
      concurrency: 16,
      store: { kind: 'memory' },
      workload: backlog(32),
    }),
  ],
  risk: (s) => [
    make('matrix', {
      id: 'fixed/sat-32w-500',
      suite: 'fixed-window',
      mechanism: 'fixed-window',
      workers: 32,
      rules: [{ limit: 500, intervalMs: 1000, algorithm: 'fixed-window' }],
      concurrency: 16,
      store: redis(s),
      workload: backlog(128),
      priority: 0,
      tags: ['risk', 'fairness'],
    }),
    make('matrix', {
      id: 'fixed/sat-8w-10',
      suite: 'fixed-window',
      mechanism: 'fixed-window',
      workers: 8,
      rules: [{ limit: 10, intervalMs: 1000, algorithm: 'fixed-window' }],
      concurrency: 16,
      store: redis(s),
      workload: backlog(32),
      priority: 0,
      tags: ['risk', 'low-quota'],
    }),
    make('matrix', {
      id: 'fixed/boundary-surge-16w',
      suite: 'fixed-window',
      mechanism: 'fixed-window',
      workers: 16,
      rules: [{ limit: 200, intervalMs: 1000, algorithm: 'fixed-window' }],
      concurrency: 16,
      store: redis(s),
      workload: {
        arrival: { kind: 'cron', everyMs: 1000, perWorker: 20, spreadMs: 50 },
        job: { kind: 'noop' },
      },
      priority: 1,
      tags: ['boundary'],
    }),
  ],
  decision: RATE_METRICS,
};

const multiSuite: SuiteDef = {
  name: 'multi-rule',
  title: 'Several rules spent atomically',
  redis: true,
  smoke: (s) => [
    make('smoke', {
      id: 'multi/smoke-4w',
      suite: 'multi-rule',
      mechanism: 'multi-rule',
      workers: 4,
      rules: [
        gcra(300, 5),
        { limit: 200, intervalMs: 1000, algorithm: 'fixed-window' },
      ],
      concurrency: 16,
      store: redis(s),
      workload: backlog(64),
    }),
  ],
  risk: (s) => [
    make('matrix', {
      id: 'multi/sat-16w-gcra-fixed',
      suite: 'multi-rule',
      mechanism: 'multi-rule',
      workers: 16,
      rules: [
        gcra(500, 10),
        { limit: 1500, intervalMs: 5000, algorithm: 'fixed-window' },
      ],
      concurrency: 16,
      store: redis(s),
      workload: backlog(128),
      priority: 0,
      tags: ['risk'],
    }),
    make('matrix', {
      id: 'multi/sat-8w-10s-300m',
      suite: 'multi-rule',
      mechanism: 'multi-rule',
      workers: 8,
      rules: [
        gcra(10),
        { limit: 300, intervalMs: 60000, algorithm: 'fixed-window' },
      ],
      concurrency: 16,
      store: redis(s),
      workload: backlog(32),
      priority: 1,
      tags: ['low-quota'],
    }),
  ],
  decision: RATE_METRICS,
};

const scopedSuite: SuiteDef = {
  name: 'scoped',
  title: 'Scoped identities with shared and per-identity rules',
  redis: true,
  smoke: (s) => [
    make('smoke', {
      id: 'scoped/smoke-4w-tenants',
      suite: 'scoped',
      mechanism: 'scoped',
      workers: 4,
      rules: [
        { name: 'shared', limit: 400, intervalMs: 1000, burst: 10 },
        {
          name: 'tenant',
          scope: 'tenant',
          limit: 40,
          intervalMs: 1000,
          algorithm: 'fixed-window',
        },
      ],
      concurrency: 16,
      store: redis(s),
      workload: {
        arrival: { kind: 'backlog', depth: 64 },
        job: {
          kind: 'noop',
          scopes: [{ dimension: 'tenant', identities: 16, skew: 1 }],
        },
      },
    }),
    make('smoke', {
      id: 'scoped/smoke-memory',
      suite: 'scoped',
      mechanism: 'scoped',
      workers: 1,
      rules: [
        {
          name: 'tenant',
          scope: 'tenant',
          limit: 20,
          intervalMs: 500,
          burst: 2,
        },
      ],
      concurrency: 16,
      store: { kind: 'memory' },
      workload: {
        arrival: { kind: 'backlog', depth: 64 },
        job: { kind: 'noop', scopes: [{ dimension: 'tenant', identities: 8 }] },
      },
    }),
  ],
  risk: (s) => [
    make('matrix', {
      id: 'scoped/skewed-16w-64t',
      suite: 'scoped',
      mechanism: 'scoped',
      workers: 16,
      rules: [
        { name: 'shared', limit: 1000, intervalMs: 1000, burst: 20 },
        {
          name: 'tenant',
          scope: 'tenant',
          limit: 50,
          intervalMs: 1000,
          burst: 5,
        },
      ],
      concurrency: 16,
      batch: 64,
      store: redis(s),
      workload: {
        arrival: { kind: 'backlog', depth: 128 },
        job: {
          kind: 'noop',
          scopes: [{ dimension: 'tenant', identities: 64, skew: 1.1 }],
        },
      },
      priority: 0,
      tags: ['risk', 'skew'],
    }),
    make('matrix', {
      id: 'scoped/independent-8w-poisson',
      suite: 'scoped',
      mechanism: 'scoped',
      workers: 8,
      rules: [
        {
          name: 'tenant',
          scope: 'tenant',
          limit: 20,
          intervalMs: 1000,
          algorithm: 'fixed-window',
        },
      ],
      concurrency: 16,
      store: redis(s),
      workload: {
        arrival: { kind: 'poisson', ratePerSec: 400 },
        job: {
          kind: 'noop',
          scopes: [{ dimension: 'tenant', identities: 32 }],
        },
      },
      priority: 1,
      tags: ['open-loop'],
    }),
  ],
  decision: RATE_METRICS,
};

const weightedSuite: SuiteDef = {
  name: 'weighted',
  title: 'Weighted costs and head-of-line prefix blocking',
  redis: true,
  smoke: (s) => [
    make('smoke', {
      id: 'weighted/smoke-4w-1-8',
      suite: 'weighted',
      mechanism: 'weighted',
      workers: 4,
      rules: [gcra(400, 8)],
      concurrency: 16,
      store: redis(s),
      workload: {
        arrival: { kind: 'backlog', depth: 64 },
        job: { kind: 'noop', costs: { values: [1, 8], weights: [0.9, 0.1] } },
      },
    }),
  ],
  risk: (s) => [
    make('matrix', {
      id: 'weighted/sat-16w-1-8',
      suite: 'weighted',
      mechanism: 'weighted',
      workers: 16,
      rules: [gcra(500, 8)],
      concurrency: 16,
      store: redis(s),
      workload: {
        arrival: { kind: 'backlog', depth: 128 },
        job: { kind: 'noop', costs: { values: [1, 8], weights: [0.9, 0.1] } },
      },
      priority: 0,
      tags: ['risk', 'hol'],
    }),
    make('matrix', {
      id: 'weighted/sat-8w-1-50',
      suite: 'weighted',
      mechanism: 'weighted',
      workers: 8,
      rules: [gcra(500, 50)],
      concurrency: 16,
      store: redis(s),
      workload: {
        arrival: { kind: 'backlog', depth: 128 },
        job: {
          kind: 'noop',
          costs: { values: [1, 50], weights: [0.97, 0.03] },
        },
      },
      priority: 1,
      tags: ['hol'],
    }),
  ],
  decision: RATE_METRICS,
};

const LEASE_METRICS: DecisionMetric[] = [
  {
    metric: 'usefulStartsPerSec',
    better: 'higher',
    margin: 0.02,
    relative: true,
    minMargin: 1,
  },
  {
    metric: 'scriptsPerUsefulJob',
    better: 'lower',
    margin: 0.05,
    relative: true,
    minMargin: 0.05,
  },
  {
    metric: 'redisCpuUsPerGrant',
    better: 'lower',
    margin: 0.1,
    relative: true,
    minMargin: 2,
  },
  {
    metric: 'open.cifP99',
    better: 'lower',
    margin: 0.1,
    relative: true,
    minMargin: 5,
  },
  { metric: 'jain', better: 'higher', margin: 0.02 },
];

const leaseSuite: SuiteDef = {
  name: 'lease',
  title: 'Global concurrency leases',
  redis: true,
  smoke: (s) => [
    make('smoke', {
      id: 'lease/smoke-4w-c4-sub',
      suite: 'lease',
      mechanism: 'lease',
      workers: 4,
      concurrency: { limit: 4, scope: 'global', leaseTtlMs: 2000 },
      store: redis(s, true),
      workload: backlog(16, {
        kind: 'async',
        duration: { kind: 'exp', meanMs: 10 },
      }),
    }),
    make('smoke', {
      id: 'lease/smoke-4w-c4-nosub',
      suite: 'lease',
      mechanism: 'lease',
      workers: 4,
      concurrency: { limit: 4, scope: 'global', leaseTtlMs: 2000 },
      store: redis(s, false),
      workload: backlog(16, {
        kind: 'async',
        duration: { kind: 'exp', meanMs: 10 },
      }),
    }),
  ],
  risk: (s) => [
    make('matrix', {
      id: 'lease/sat-16w-c8-20ms-sub',
      suite: 'lease',
      mechanism: 'lease',
      workers: 16,
      concurrency: { limit: 8, scope: 'global', leaseTtlMs: 5000 },
      store: redis(s, true),
      workload: backlog(32, {
        kind: 'async',
        duration: { kind: 'exp', meanMs: 20 },
      }),
      priority: 0,
      tags: ['risk', 'subscriber'],
    }),
    make('matrix', {
      id: 'lease/sat-16w-c8-20ms-nosub',
      suite: 'lease',
      mechanism: 'lease',
      workers: 16,
      concurrency: { limit: 8, scope: 'global', leaseTtlMs: 5000 },
      store: redis(s, false),
      workload: backlog(32, {
        kind: 'async',
        duration: { kind: 'exp', meanMs: 20 },
      }),
      priority: 0,
      tags: ['risk', 'polling'],
    }),
    make('matrix', {
      id: 'lease/storm-32w-c4-sub',
      suite: 'lease',
      mechanism: 'lease',
      workers: 32,
      concurrency: { limit: 4, scope: 'global', leaseTtlMs: 5000 },
      store: redis(s, true),
      workload: backlog(16, {
        kind: 'async',
        duration: { kind: 'fixed', ms: 5 },
      }),
      priority: 0,
      tags: ['risk', 'notice-storm'],
    }),
    make('matrix', {
      id: 'lease/sync-8w-c4',
      suite: 'lease',
      mechanism: 'lease',
      workers: 8,
      concurrency: { limit: 4, scope: 'global', leaseTtlMs: 5000 },
      store: redis(s, true),
      workload: backlog(16, {
        kind: 'sync',
        duration: { kind: 'fixed', ms: 0.5 },
      }),
      priority: 1,
      tags: ['sync-cpu'],
    }),
  ],
  decision: LEASE_METRICS,
};

const combinedSuite: SuiteDef = {
  name: 'combined',
  title: 'Rate rules plus global leases in one admission',
  redis: true,
  smoke: (s) => [
    make('smoke', {
      id: 'combined/smoke-4w',
      suite: 'combined',
      mechanism: 'combined',
      workers: 4,
      rules: [gcra(300, 5)],
      concurrency: { limit: 6, scope: 'global', leaseTtlMs: 2000 },
      store: redis(s, true),
      workload: poisson(250, {
        kind: 'async',
        duration: { kind: 'exp', meanMs: 8 },
      }),
    }),
  ],
  risk: (s) => [
    make('matrix', {
      id: 'combined/sat-16w-500-c8',
      suite: 'combined',
      mechanism: 'combined',
      workers: 16,
      rules: [gcra(500)],
      concurrency: { limit: 8, scope: 'global', leaseTtlMs: 5000 },
      store: redis(s, true),
      workload: backlog(64, {
        kind: 'async',
        duration: { kind: 'exp', meanMs: 10 },
      }),
      priority: 0,
      tags: ['risk'],
    }),
  ],
  decision: [...RATE_METRICS, ...LEASE_METRICS.slice(0, 2)],
};

const deadlineSuite: SuiteDef = {
  name: 'deadlines',
  title: 'maxWait, urgent cohorts and cancellation races',
  redis: true,
  smoke: (s) => [
    make('smoke', {
      id: 'deadlines/smoke-urgent-4w',
      suite: 'deadlines',
      mechanism: 'gcra',
      workers: 4,
      rules: [gcra(300)],
      concurrency: 16,
      store: redis(s),
      workload: {
        arrival: { kind: 'backlog', depth: 32 },
        job: { kind: 'noop' },
        deadlines: { urgent: { ratePerSec: 30, maxWaitMs: 15, priority: 10 } },
      },
    }),
    make('smoke', {
      id: 'deadlines/smoke-abort-4w',
      suite: 'deadlines',
      mechanism: 'cancellation',
      workers: 4,
      rules: [gcra(200)],
      concurrency: 16,
      store: redis(s),
      workload: {
        arrival: { kind: 'poisson', ratePerSec: 300 },
        job: { kind: 'noop' },
        abort: {
          fraction: 0.3,
          after: { kind: 'uniform', minMs: 0, maxMs: 60 },
        },
        deadlines: { maxWaitMs: 200, fraction: 0.5 },
      },
    }),
    make('smoke', {
      id: 'deadlines/smoke-memory-sync',
      suite: 'deadlines',
      mechanism: 'gcra',
      workers: 1,
      rules: [gcra(1000, 32)],
      concurrency: 32,
      batch: 32,
      store: { kind: 'memory' },
      workload: {
        arrival: { kind: 'backlog', depth: 64 },
        job: { kind: 'sync', duration: { kind: 'fixed', ms: 2 } },
        deadlines: { maxWaitMs: 20, fraction: 1 },
      },
      tags: ['c1-exposure'],
    }),
  ],
  risk: (s) => [
    ...[
      [4, 500],
      [32, 500],
      [64, 500],
      [32, 1000],
    ].map(([w, q]) =>
      make('matrix', {
        id: `deadlines/urgent-${w}w-${q}`,
        suite: 'deadlines',
        mechanism: 'gcra',
        workers: w!,
        rules: [gcra(q!)],
        concurrency: 16,
        store: redis(s),
        workload: {
          arrival: { kind: 'backlog', depth: 128 },
          job: { kind: 'noop' },
          deadlines: {
            urgent: { ratePerSec: q! * 0.05, maxWaitMs: 15, priority: 10 },
          },
        },
        priority: 0,
        tags: ['risk', 'urgent'],
      }),
    ),
    make('matrix', {
      id: 'deadlines/abort-race-16w',
      suite: 'deadlines',
      mechanism: 'cancellation',
      workers: 16,
      rules: [gcra(500)],
      concurrency: 16,
      store: redis(s),
      workload: {
        arrival: { kind: 'poisson', ratePerSec: 600 },
        job: { kind: 'noop' },
        abort: { fraction: 0.2, after: { kind: 'exp', meanMs: 20 } },
        deadlines: { maxWaitMs: 100, fraction: 0.5 },
      },
      priority: 1,
      tags: ['abort'],
    }),
  ],
  decision: RATE_METRICS,
};

const SERVERS = ['redis62', 'redis74', 'redis8', 'valkey72', 'valkey8'];
const storesSuite: SuiteDef = {
  name: 'stores',
  title: 'Redis and Valkey versions (correctness across servers)',
  redis: true,
  smoke: () =>
    SERVERS.flatMap((server) => [
      make('smoke', {
        id: `stores/${server}-rate`,
        suite: 'stores',
        mechanism: 'multi-rule',
        workers: 3,
        rules: [
          gcra(300, 5),
          { limit: 150, intervalMs: 500, algorithm: 'fixed-window' },
        ],
        concurrency: 16,
        store: redis(server),
        workload: backlog(32),
        tags: [server],
      }),
      make('smoke', {
        id: `stores/${server}-lease`,
        suite: 'stores',
        mechanism: 'combined',
        workers: 3,
        rules: [gcra(400)],
        concurrency: { limit: 3, scope: 'global', leaseTtlMs: 2000 },
        store: redis(server, true),
        workload: backlog(16, {
          kind: 'async',
          duration: { kind: 'exp', meanMs: 5 },
        }),
        tags: [server],
      }),
    ]),
  risk: () =>
    ['redis74', 'valkey8'].map((server) =>
      make('matrix', {
        id: `stores/${server}-sat-32w-500`,
        suite: 'stores',
        mechanism: 'gcra',
        workers: 32,
        rules: [gcra(500)],
        concurrency: 16,
        store: redis(server),
        workload: backlog(128),
        priority: 0,
        tags: ['risk', server],
      }),
    ),
  decision: RATE_METRICS,
};

const lifecycleSuite: SuiteDef = {
  name: 'lifecycle',
  title: 'Worker join, leave and crash',
  redis: true,
  faults: false,
  smoke: (s) => [
    make('smoke', {
      id: 'lifecycle/smoke-join-leave',
      suite: 'lifecycle',
      mechanism: 'gcra',
      workers: 4,
      rules: [gcra(300)],
      concurrency: 16,
      store: redis(s),
      workload: backlog(32),
      faults: [
        { atMs: 400, type: 'spawn-workers', count: 2 },
        { atMs: 900, type: 'kill-workers', workers: [0] },
      ],
      tags: ['churn'],
    }),
  ],
  risk: (s) => [
    make('matrix', {
      id: 'lifecycle/churn-32w-500',
      suite: 'lifecycle',
      mechanism: 'gcra',
      workers: 32,
      rules: [gcra(500)],
      concurrency: 16,
      store: redis(s),
      workload: backlog(128),
      faults: [
        { atMs: 1500, type: 'kill-workers', workers: [0, 1, 2, 3, 4, 5, 6, 7] },
        { atMs: 2500, type: 'spawn-workers', count: 8 },
      ],
      priority: 0,
      tags: ['risk', 'churn'],
    }),
    make('matrix', {
      id: 'lifecycle/lease-crash-8w',
      suite: 'lifecycle',
      mechanism: 'lease',
      workers: 8,
      concurrency: { limit: 4, scope: 'global', leaseTtlMs: 1000 },
      store: redis(s, true),
      workload: backlog(16, {
        kind: 'async',
        duration: { kind: 'fixed', ms: 200 },
      }),
      faults: [{ atMs: 1000, type: 'kill-workers', workers: [0, 1] }],
      priority: 0,
      tags: ['risk', 'crash', 'lease-ttl'],
    }),
  ],
  decision: [
    { metric: 'capacityUtilization', better: 'higher', margin: 0.01 },
    {
      metric: 'usefulStartsPerSec',
      better: 'higher',
      margin: 0.02,
      relative: true,
      minMargin: 1,
    },
  ],
};

const faultSuite: SuiteDef = {
  name: 'faults',
  title:
    'Server faults: restart, pause beyond TTL, client kill, stall, CPU and command load',
  redis: true,
  faults: true,
  smoke: (s) => [
    make('smoke', {
      id: 'faults/smoke-client-kill',
      suite: 'faults',
      mechanism: 'combined',
      workers: 3,
      rules: [gcra(300)],
      concurrency: { limit: 4, scope: 'global', leaseTtlMs: 2000 },
      store: redis(s, true),
      workload: backlog(16, {
        kind: 'async',
        duration: { kind: 'exp', meanMs: 5 },
      }),
      faults: [{ atMs: 700, type: 'client-kill' }],
      tags: ['fault'],
    }),
  ],
  risk: (s) => [
    make('matrix', {
      id: 'faults/client-kill-3w',
      suite: 'faults',
      mechanism: 'combined',
      workers: 3,
      rules: [gcra(300)],
      concurrency: { limit: 4, scope: 'global', leaseTtlMs: 2000 },
      store: redis(s, true),
      workload: backlog(16, {
        kind: 'async',
        duration: { kind: 'exp', meanMs: 5 },
      }),
      faults: [{ atMs: 1500, type: 'client-kill' }],
      priority: 1,
      tags: ['fault'],
    }),
    make('matrix', {
      id: 'faults/restart-8w',
      suite: 'faults',
      mechanism: 'gcra',
      workers: 8,
      rules: [gcra(300)],
      concurrency: 16,
      store: redis(s),
      workload: backlog(64),
      faults: [{ atMs: 1500, type: 'redis-restart' }],
      priority: 1,
      tags: ['fault', 'state-loss'],
    }),
    make('matrix', {
      id: 'faults/pause-beyond-ttl-8w',
      suite: 'faults',
      mechanism: 'lease',
      workers: 8,
      concurrency: { limit: 4, scope: 'global', leaseTtlMs: 600 },
      store: redis(s, true),
      workload: backlog(16, {
        kind: 'async',
        duration: { kind: 'fixed', ms: 20 },
      }),
      faults: [{ atMs: 1500, type: 'redis-pause', ms: 1000 }],
      priority: 1,
      tags: ['fault', 'lease-ttl'],
    }),
    make('matrix', {
      id: 'faults/stall-16w',
      suite: 'faults',
      mechanism: 'gcra',
      workers: 16,
      rules: [gcra(500)],
      concurrency: 16,
      store: redis(s),
      workload: backlog(64),
      faults: [{ atMs: 1500, type: 'redis-stall', ms: 300 }],
      priority: 1,
      tags: ['fault'],
    }),
    make('matrix', {
      id: 'faults/cpu-32w',
      suite: 'faults',
      mechanism: 'gcra',
      workers: 32,
      rules: [gcra(500)],
      concurrency: 16,
      store: redis(s),
      workload: backlog(128),
      faults: [{ atMs: 0, type: 'redis-cpu', duty: 0.9, forMs: 4000 }],
      priority: 1,
      tags: ['fault', 'redis-cpu'],
    }),
    make('matrix', {
      id: 'faults/load-16w',
      suite: 'faults',
      mechanism: 'gcra',
      workers: 16,
      rules: [gcra(500)],
      concurrency: 16,
      store: redis(s),
      workload: backlog(64),
      faults: [{ atMs: 0, type: 'redis-load', opsPerSec: 20000, forMs: 4000 }],
      priority: 2,
      tags: ['fault', 'interference'],
    }),
  ],
  decision: [{ metric: 'capacityUtilization', better: 'higher', margin: 0.01 }],
};

const runtimeSuite: SuiteDef = {
  name: 'runtime',
  title:
    'Event-loop activity, synchronous job CPU and instrumentation overhead',
  redis: true,
  smoke: (s) => [
    make('smoke', {
      id: 'runtime/smoke-bgloop-4w',
      suite: 'runtime',
      mechanism: 'gcra',
      workers: 4,
      rules: [gcra(400)],
      concurrency: 16,
      store: redis(s),
      workload: { ...backlog(32), runtime: { bgTimerMs: 1, bgWorkMs: 0.05 } },
      tags: ['bgloop'],
    }),
  ],
  risk: (s) => [
    make('matrix', {
      id: 'runtime/bgloop-32w-500',
      suite: 'runtime',
      mechanism: 'gcra',
      workers: 32,
      rules: [gcra(500)],
      concurrency: 16,
      store: redis(s),
      workload: { ...backlog(128), runtime: { bgTimerMs: 1, bgWorkMs: 0.05 } },
      priority: 0,
      tags: ['risk', 'bgloop'],
    }),
    make('matrix', {
      id: 'runtime/bgloop-32w-1000',
      suite: 'runtime',
      mechanism: 'gcra',
      workers: 32,
      rules: [gcra(1000)],
      concurrency: 16,
      store: redis(s),
      workload: { ...backlog(128), runtime: { bgTimerMs: 1, bgWorkMs: 0.05 } },
      priority: 0,
      tags: ['risk', 'bgloop'],
    }),
    make('matrix', {
      id: 'runtime/sync-8w-1000',
      suite: 'runtime',
      mechanism: 'gcra',
      workers: 8,
      rules: [gcra(1000)],
      concurrency: 16,
      store: redis(s),
      workload: backlog(128, {
        kind: 'sync',
        duration: { kind: 'fixed', ms: 0.5 },
      }),
      priority: 0,
      tags: ['risk', 'sync-cpu'],
    }),
    make('matrix', {
      id: 'runtime/eld1ms-32w-500',
      suite: 'runtime',
      mechanism: 'gcra',
      workers: 32,
      rules: [gcra(500)],
      concurrency: 16,
      store: redis(s),
      workload: { ...backlog(128), runtime: { eldResolutionMs: 1 } },
      priority: 2,
      tags: ['instrumentation-overhead'],
      notes: [
        'pairs with gcra/sat-32w-500-b1 to quantify 1 ms event-loop sampling overhead',
      ],
    }),
  ],
  decision: RATE_METRICS,
};

const net = (delayMs: number, jitterMs: number): NetworkSpec => ({
  delayMs,
  jitterMs,
});
const networkSuite: SuiteDef = {
  name: 'network',
  title: 'Store RTT with jitter (fixed delay only paired with jitter)',
  redis: true,
  netem: true,
  smoke: () => [
    make('smoke', {
      id: 'network/smoke-5ms',
      suite: 'network',
      mechanism: 'gcra',
      workers: 4,
      rules: [gcra(300)],
      concurrency: 16,
      store: redis('redis74-netem'),
      network: net(5, 2),
      workload: backlog(32),
      tags: ['rtt'],
    }),
  ],
  risk: () =>
    (
      [
        ['5j2', net(5, 2)],
        ['25j8', net(25, 8)],
        ['25fixed', net(25, 0)],
      ] as const
    ).map(([name, n]) =>
      make('matrix', {
        id: `network/sat-32w-500-${name}`,
        suite: 'network',
        mechanism: 'gcra',
        workers: 32,
        rules: [gcra(500)],
        concurrency: 16,
        store: redis('redis74-netem'),
        network: n,
        workload: backlog(128),
        priority: 0,
        tags: [
          'risk',
          'rtt',
          ...(n.jitterMs ? [] : ['fixed-rtt-artifact-check']),
        ],
      }),
    ),
  decision: RATE_METRICS,
};

const apiSuite: SuiteDef = {
  name: 'api',
  title: 'Public wrappers and shared pause/feedback controls',
  redis: true,
  smoke: (s) => [
    ...(['wrap', 'wrapFetch'] as const).map((apiMode) =>
      make('smoke', {
        id: `api/${apiMode}`,
        suite: 'api',
        apiMode,
        mechanism: 'gcra',
        workers: 2,
        rules: [gcra(100, 2)],
        concurrency: 4,
        store: redis(s),
        workload: poisson(60),
      }),
    ),
    make('smoke', {
      id: 'api/pause-resume-feedback',
      suite: 'api',
      mechanism: 'gcra',
      workers: 2,
      instances: 2,
      rules: [gcra(100, 2)],
      concurrency: 4,
      store: redis(s, true),
      workload: poisson(80),
      controls: [
        { atMs: 300, worker: 0, action: 'pause', durationMs: 300 },
        { atMs: 500, worker: 0, action: 'resume' },
        { atMs: 800, worker: 0, action: 'observe', durationMs: 150 },
      ],
    }),
    make('smoke', {
      id: 'api/queue-capacity-batch1',
      suite: 'api',
      mechanism: 'gcra',
      workers: 1,
      batch: 1,
      maxQueue: 4,
      rules: [gcra(50)],
      concurrency: 2,
      store: { kind: 'memory' },
      workload: {
        arrival: { kind: 'cron', everyMs: 250, perWorker: 20, spreadMs: 1 },
        job: { kind: 'noop' },
      },
    }),
  ],
  risk: (s) =>
    apiSuite.smoke(s).map((c) => ({
      ...c,
      id: `${c.id}-risk`,
      priority: 0,
      timing: { ...c.timing, windowMs: 4000 },
    })),
  decision: RATE_METRICS,
};

export const SUITES: SuiteDef[] = [
  gcraSuite,
  fixedSuite,
  multiSuite,
  scopedSuite,
  weightedSuite,
  leaseSuite,
  combinedSuite,
  deadlineSuite,
  storesSuite,
  lifecycleSuite,
  faultSuite,
  runtimeSuite,
  networkSuite,
  apiSuite,
];

/** Resolve a workload suite by name and report the available names on invalid input. */
export function suite(name: string): SuiteDef {
  const s = SUITES.find((x) => x.name === name);
  if (!s)
    throw new Error(
      `unknown suite ${name}; known: ${SUITES.map((x) => x.name).join(', ')}`,
    );
  return s;
}

/** Covering cells of a suite (seeded, deterministic). */
export function coveringCells(
  def: SuiteDef,
  store: string,
  seed = 7,
): CellSpec[] {
  if (!def.covering) return [];
  return pairwise(def.covering.factors, seed).map((row) =>
    def.covering!.build(row, store),
  );
}

/** Rewrite a cell to run against another server (e.g. Valkey) under a distinct id. */
export function onServer(cell: CellSpec, server: string): CellSpec {
  if (cell.store.kind !== 'redis' || cell.store.server === server) return cell;
  return {
    ...cell,
    id: `${cell.id}@${server}`,
    store: { ...cell.store, server },
    tags: [...cell.tags, server],
  };
}
