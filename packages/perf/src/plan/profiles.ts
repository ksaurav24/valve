// Profiles turn suites into concrete cell lists, arms, looks and budgets (RFC §5).
import type { CellSpec, DecisionMetric, DecisionPlan } from '../core/types.ts';
import {
  coveringCells,
  onServer,
  suite,
  SUITES,
  type SuiteDef,
} from './suites.ts';

export type ProfileName =
  'smoke' | 'targeted' | 'nightly' | 'decision' | 'sylvie';

export interface ProfileDef {
  name: ProfileName;
  looks: number[];
  alpha: number;
  /** Default wall-clock budget in seconds (truncation by priority), or null for none. */
  budgetSec: number | null;
  /** Run instrumented audit trials (rep 0) alongside uninstrumented performance arms. */
  audit: boolean;
  description: string;
}

export const PROFILES: Record<ProfileName, ProfileDef> = {
  smoke: {
    name: 'smoke',
    looks: [1],
    alpha: 0.05,
    budgetSec: null,
    audit: false,
    description:
      "Every suite's smoke cells, 1 rep, instrumented correctness arm, Redis 7.4 + Valkey 8 + memory. No performance verdicts.",
  },
  targeted: {
    name: 'targeted',
    looks: [5],
    alpha: 0.05,
    budgetSec: null,
    audit: true,
    description:
      'Risk cells of selected suites, base/aa/head arms, 5 reps (fixed n).',
  },
  sylvie: {
    name: 'sylvie',
    looks: [10],
    alpha: 0.05,
    budgetSec: null,
    audit: true,
    description:
      'Two-worker rate and lease cells, 15 s windows, 10 fixed pairs, isolated physical cores. About 20 min on Sylvie (i5-12450H).',
  },
  nightly: {
    name: 'nightly',
    looks: [5],
    alpha: 0.05,
    budgetSec: 40 * 60,
    audit: true,
    description:
      'Risk cells of all suites by priority within a budget (default 40 min), 5 reps.',
  },
  decision: {
    name: 'decision',
    looks: [5, 10, 20],
    alpha: 0.05,
    budgetSec: null,
    audit: true,
    description:
      'Risk + pairwise covering cells, staged looks 5/10/20 with Bonferroni α/3 per look.',
  },
};

export interface ProfileCells {
  cells: CellSpec[];
  skipped: { what: string; reason: string }[];
}

/** Server availability decides which suites can run (network needs a -netem server, stores needs every version). */
export function profileCells(
  profile: ProfileName,
  suites: readonly string[] | undefined,
  available: ReadonlySet<string>,
  options: { store?: string; valkey?: boolean } = {},
): ProfileCells {
  const store = options.store ?? 'redis74';
  if (profile === 'sylvie') {
    const selected = [
      ['gcra', 'gcra/sat-4w-500-b1'],
      ['lease', 'lease/sat-16w-c8-20ms-sub'],
    ] as const;
    for (const name of suites ?? [])
      if (!selected.some(([s]) => s === name))
        throw new Error(
          `sylvie covers gcra and lease; use targeted for ${name}`,
        );
    const cells = selected
      .filter(([name]) => !suites?.length || suites.includes(name))
      .map(([name, id]): CellSpec => {
        const base = suite(name)
          .risk(store)
          .find((c) => c.id === id)!;
        return {
          ...base,
          id: `sylvie/${name}-2w`,
          workers: 2,
          timing: { warmupMs: 2000, windowMs: 15000, drainMs: 500 },
          tags: [...base.tags, 'sylvie'],
          notes: [
            ...(base.notes ?? []),
            `Sylvie workload derived from ${id}, reduced to two workers; a focused comparison, not full fleet coverage.`,
          ],
        };
      });
    return {
      cells: available.has(store) ? cells : [],
      skipped: available.has(store)
        ? []
        : cells.map((c) => ({
            what: c.id,
            reason: `server ${store} not set up`,
          })),
    };
  }
  const chosen: SuiteDef[] = suites?.length ? suites.map(suite) : SUITES;
  const cells: CellSpec[] = [];
  const skipped: ProfileCells['skipped'] = [];
  for (const def of chosen) {
    let list =
      profile === 'smoke'
        ? def.smoke(store)
        : profile === 'decision'
          ? [...def.risk(store), ...coveringCells(def, store)]
          : def.risk(store);
    // Smoke repeats the core mechanism suites on Valkey 8 as well.
    if (
      profile === 'smoke' &&
      (options.valkey ?? true) &&
      ['gcra', 'lease', 'scoped', 'combined'].includes(def.name) &&
      available.has('valkey8')
    )
      list = [
        ...list,
        ...def
          .smoke(store)
          .filter((c) => c.store.kind === 'redis' && c.store.server === store)
          .map((c) => onServer(c, 'valkey8')),
      ];
    for (const c of list) {
      const server = c.store.kind === 'redis' ? c.store.server : undefined;
      if (server && !available.has(server))
        skipped.push({
          what: c.id,
          reason: `server ${server} not set up (pnpm perf infra up ${server})`,
        });
      else cells.push(c);
    }
  }
  return { cells, skipped };
}

/** Combine a profile's preregistered looks and alpha with its selected decision metrics. */
export function decisionPlan(
  profile: ProfileDef,
  metrics: DecisionMetric[],
): DecisionPlan {
  return { metrics, looks: profile.looks, alpha: profile.alpha };
}

/** Preregistered metrics of the suite that owns a cell. */
export function metricsFor(cell: CellSpec): DecisionMetric[] {
  const def = SUITES.find((s) => s.name === cell.suite);
  return (def?.decision ?? []).filter((m) => {
    // Equal-share fairness needs at least two workers; N/A must not gate A/A.
    if (m.metric === 'jain' && cell.workers < 2) return false;
    if (
      m.metric.startsWith('open.') &&
      ['backlog', 'clients'].includes(cell.workload.arrival.kind)
    )
      return false;
    if (m.metric.startsWith('urgent.') && !cell.workload.deadlines?.urgent)
      return false;
    if (m.metric.startsWith('redis') && cell.store.kind !== 'redis')
      return false;
    return true;
  });
}

/** Keep the highest-priority cells whose estimated cost fits the budget. */
export function truncateToBudget<T extends { cell: CellSpec; seconds: number }>(
  items: T[],
  budgetSec: number,
): { kept: T[]; dropped: T[] } {
  const sorted = [...items].sort(
    (a, b) =>
      a.cell.priority - b.cell.priority || a.cell.id.localeCompare(b.cell.id),
  );
  const kept: T[] = [];
  const dropped: T[] = [];
  let used = 0;
  for (const it of sorted) {
    if (used + it.seconds <= budgetSec) {
      kept.push(it);
      used += it.seconds;
    } else dropped.push(it);
  }
  return { kept, dropped };
}
