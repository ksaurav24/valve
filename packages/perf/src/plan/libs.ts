// Competitor comparison cells: one cell per (category, library) where the library supports the
// category's contract; unsupported pairs are recorded as N/A with the adapter's own reason.
// Identical workloads, job bodies and timing for every library; no tuning per library.
import type {
  CellSpec,
  DecisionMetric,
  LibraryId,
  WorkloadSpec,
} from '../core/types.ts';
import { adapterFor } from '../adapters/index.ts';
import type { Scale } from './suites.ts';

export const LIBRARIES: LibraryId[] = [
  'valve',
  'p-limit',
  'p-queue',
  'bottleneck',
  'identity',
];

/** The id distinguishes the synchronous scheduling diagnostic from async L1. */
export function libraryCategory(cell: CellSpec): string {
  return cell.id.split('/')[1]!;
}

/** Fixed before execution; wait is conditional on starting, alongside raw outcomes. */
export function libraryMetricsFor(cell: CellSpec): DecisionMetric[] {
  const cohort = cell.workload.arrival.kind === 'backlog' ? 'backlog' : 'open';
  return [
    {
      metric: 'usefulStartsPerSec',
      better: 'higher',
      margin: 0.02,
      relative: true,
      minMargin: 1,
    },
    {
      metric: 'appCpuUsPerGrant',
      better: 'lower',
      margin: 0.1,
      relative: true,
      minMargin: 5,
    },
    {
      metric: `${cohort}.waitP99`,
      better: 'lower',
      margin: 0.1,
      relative: true,
      minMargin: 2,
    },
  ];
}

interface CategoryCell {
  id: string;
  title: string;
  base: Omit<
    CellSpec,
    'id' | 'library' | 'timing' | 'priority' | 'tags' | 'suite'
  >;
  /** Whether the identity floor row is meaningful (it enforces nothing). */
  identity: boolean;
}

const async1: WorkloadSpec['job'] = {
  kind: 'async',
  duration: { kind: 'fixed', ms: 1 },
};

export const LIB_CATEGORIES: CategoryCell[] = [
  {
    id: 'L1',
    title: 'Local concurrency (C=16), 1 ms async jobs, deep backlog',
    identity: true,
    base: {
      category: 'L1',
      mechanism: 'local-concurrency',
      workers: 1,
      concurrency: 16,
      store: { kind: 'memory' },
      workload: { arrival: { kind: 'backlog', depth: 2000 }, job: async1 },
    },
  },
  {
    id: 'L1-noop',
    title:
      'Local concurrency (C=16), synchronous no-op jobs (scheduling overhead)',
    identity: true,
    base: {
      category: 'L1',
      mechanism: 'local-concurrency',
      workers: 1,
      concurrency: 16,
      store: { kind: 'memory' },
      workload: {
        arrival: { kind: 'backlog', depth: 2000 },
        job: { kind: 'noop' },
      },
    },
  },
  {
    id: 'L2',
    title: 'Local burst-1 pacing, 200/s',
    identity: false,
    base: {
      category: 'L2',
      mechanism: 'pacing',
      workers: 1,
      rules: [{ limit: 200, intervalMs: 1000, burst: 1 }],
      store: { kind: 'memory' },
      workload: {
        arrival: { kind: 'backlog', depth: 64 },
        job: { kind: 'noop' },
      },
    },
  },
  {
    id: 'L3',
    title: 'Local fixed window, 100 per 500 ms',
    identity: false,
    base: {
      category: 'L3',
      mechanism: 'window',
      workers: 1,
      rules: [{ limit: 100, intervalMs: 500, algorithm: 'fixed-window' }],
      store: { kind: 'memory' },
      workload: {
        arrival: { kind: 'backlog', depth: 128 },
        job: { kind: 'noop' },
      },
    },
  },
  {
    id: 'L4',
    title: 'Local burst bank, 100/s burst 20 (Bottleneck approximate)',
    identity: false,
    base: {
      category: 'L4',
      mechanism: 'burst-bank',
      workers: 1,
      rules: [{ limit: 100, intervalMs: 1000, burst: 20 }],
      store: { kind: 'memory' },
      workload: {
        arrival: { kind: 'bursty', ratePerSec: 400, onMs: 200, offMs: 800 },
        job: { kind: 'noop' },
      },
    },
  },
  {
    id: 'L5',
    title: 'Queued cancellation, 30% aborted within 50 ms',
    identity: false,
    base: {
      category: 'L5',
      mechanism: 'cancellation',
      workers: 1,
      concurrency: 4,
      store: { kind: 'memory' },
      workload: {
        arrival: { kind: 'poisson', ratePerSec: 800 },
        job: { kind: 'async', duration: { kind: 'fixed', ms: 5 } },
        abort: {
          queuedOnly: true,
          fraction: 0.3,
          after: { kind: 'uniform', minMs: 0, maxMs: 50 },
        },
      },
    },
  },
  {
    id: 'D1',
    title: 'Distributed global concurrency C=8 over 4 processes, 10 ms jobs',
    identity: false,
    base: {
      category: 'D1',
      mechanism: 'lease',
      workers: 4,
      concurrency: { limit: 8, scope: 'global', leaseTtlMs: 5000 },
      store: { kind: 'redis', server: 'redis74', subscriber: true },
      workload: {
        arrival: { kind: 'backlog', depth: 32 },
        job: { kind: 'async', duration: { kind: 'fixed', ms: 10 } },
      },
    },
  },
  {
    id: 'D2',
    title: 'Distributed burst-1 pacing 200/s over 4 processes',
    identity: false,
    base: {
      category: 'D2',
      mechanism: 'pacing',
      workers: 4,
      rules: [{ limit: 200, intervalMs: 1000, burst: 1 }],
      store: { kind: 'redis', server: 'redis74' },
      workload: {
        arrival: { kind: 'backlog', depth: 32 },
        job: { kind: 'noop' },
      },
    },
  },
  {
    id: 'D3',
    title: 'Distributed fixed window 200 per 1 s over 4 processes',
    identity: false,
    base: {
      category: 'D3',
      mechanism: 'window',
      workers: 4,
      rules: [{ limit: 200, intervalMs: 1000, algorithm: 'fixed-window' }],
      store: { kind: 'redis', server: 'redis74' },
      workload: {
        arrival: { kind: 'backlog', depth: 64 },
        job: { kind: 'noop' },
      },
    },
  },
];

export interface LibsPlan {
  cells: CellSpec[];
  na: { category: string; library: LibraryId; reason: string }[];
}

export function libsCells(
  scale: Scale,
  categories?: readonly string[],
  server?: string,
): LibsPlan {
  const cells: CellSpec[] = [];
  const na: LibsPlan['na'] = [];
  const timing =
    scale === 'smoke'
      ? { warmupMs: 300, windowMs: 1500, drainMs: 1000 }
      : { warmupMs: 1000, windowMs: 4000, drainMs: 2000 };
  for (const cat of LIB_CATEGORIES) {
    if (
      categories?.length &&
      !categories.includes(cat.id) &&
      !categories.includes(cat.base.category!)
    )
      continue;
    for (const library of LIBRARIES) {
      if (library === 'identity' && !cat.identity) {
        na.push({
          category: cat.id,
          library,
          reason:
            'identity floor enforces nothing; only reported for pure scheduling-overhead categories',
        });
        continue;
      }
      const store =
        server && cat.base.store.kind === 'redis'
          ? { ...cat.base.store, server }
          : cat.base.store;
      const cell: CellSpec = {
        ...cat.base,
        store,
        id: `libs/${cat.id}/${library}`,
        suite: 'libs',
        library,
        timing:
          cat.id === 'L1' || cat.id === 'L1-noop'
            ? { warmupMs: 100, windowMs: 100, drainMs: 100 }
            : timing,
        priority: 0,
        tags: ['libs', cat.id],
        notes: [
          cat.title,
          ...(cat.id === 'L1' || cat.id === 'L1-noop'
            ? [
                'Local overhead diagnostic: uniform 100 ms warmup/window/drain defaults bound deep-backlog recording. Explicit longer windows can exhaust the recording cap; no distributed performance claim.',
              ]
            : []),
        ],
      };
      const ok =
        library === 'identity' ? true : adapterFor(library).supports(cell);
      if (ok === true) cells.push(cell);
      else na.push({ category: cat.id, library, reason: ok });
    }
  }
  return { cells, na };
}
