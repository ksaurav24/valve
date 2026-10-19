// Profiles turn suites into concrete cell lists, arms, looks and budgets (RFC §5).
import type { CellSpec, DecisionMetric, DecisionPlan } from '../core/types.ts';
import {
  coveringCells,
  onServer,
  suite,
  SUITES,
  type SuiteDef,
} from './suites.ts';

export type ProfileName = 'smoke' | 'targeted' | 'nightly' | 'decision';

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
