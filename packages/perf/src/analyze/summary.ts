// Aggregated, report-ready results of a run. Produced by analyze/aggregate.ts, rendered by report/*.
import type {
  BuildIdentity,
  DecisionPlan,
  PerfVerdict,
  SafetyStatus,
  ViolationClass,
} from '../core/types.ts';

export interface MetricStat {
  n: number;
  mean: number | null;
  sd: number | null;
  min: number | null;
  median: number | null;
  max: number | null;
  /** All per-rep values in rep order (null where not measurable). */
  values: (number | null)[];
}

export interface Comparison {
  metric: string;
  /** Candidate arm compared against `base` (or `aa` vs base for the A/A control). */
  arm: string;
  better: 'higher' | 'lower';
  n: number;
  meanDiff: number | null;
  /** Interval on the paired mean difference at this look's alpha; null when n < 5. */
  lo: number | null;
  hi: number | null;
  alphaLook: number | null;
  margin: number;
  permutationP: number | null;
  /** Holm-adjusted p within the suite, when computed. */
  adjustedP: number | null;
  verdict: PerfVerdict;
  reason: string;
}

export interface ArmSafety {
  arm: string;
  status: SafetyStatus;
  trials: number;
  counts: Partial<Record<ViolationClass, number>>;
  unverified: ViolationClass[];
  samples: string[];
}

export interface CellSummary {
  cellId: string;
  suite: string;
  description: string;
  tags: string[];
  notes: string[];
  arms: string[];
  /** arm -> metric -> stat */
  metrics: Record<string, Record<string, MetricStat>>;
  /** arm -> cohort -> outcome -> total count across reps */
  outcomes: Record<string, Record<string, Record<string, number>>>;
  safety: ArmSafety[];
  comparisons: Comparison[];
  /** Trials excluded as resource-invalid, by arm. */
  invalidTrials: Record<string, number>;
  /** Final verdict of the A/A control, if present. */
  aaVerdict?: PerfVerdict;
}

export interface RunSummary {
  runId: string;
  profile: string;
  tier: string;
  createdAt: string;
  authoritative: boolean;
  fingerprintId: string;
  fingerprint: Record<string, unknown>;
  builds: Record<string, BuildIdentity>;
  decision?: DecisionPlan;
  /** Overall absolute safety: FAIL if any arm failed in any cell. */
  safety: SafetyStatus;
  cells: CellSummary[];
  /** Planned-but-not-executed cells or profiles, with reasons. */
  notExecuted: { what: string; reason: string }[];
  warnings: string[];
  durationSec: number;
}
