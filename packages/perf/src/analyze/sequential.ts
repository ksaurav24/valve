// Preregistered staged decisions with Bonferroni error control across looks.
import type {
  DecisionMetric,
  DecisionPlan,
  PerfVerdict,
} from '../core/types.ts';
import { pairedT } from './stats.ts';

/** α/L: the union bound controls any false interval exclusion across L preregistered looks, even when stopping early. */
export function alphaPerLook(plan: DecisionPlan): number {
  if (
    plan.looks.length === 0 ||
    plan.looks.some(
      (n, i) =>
        !Number.isInteger(n) || n < 1 || (i > 0 && n <= plan.looks[i - 1]!),
    ) ||
    !(plan.alpha > 0 && plan.alpha < 1)
  )
    throw new RangeError('a plan needs looks and alpha in (0,1)');
  return plan.alpha / plan.looks.length;
}

/** Inputs for a decision at one preregistered look; differences are arm minus baseline. */
export interface VerdictInput {
  diffs: readonly number[];
  metric: DecisionMetric;
  baseMean: number;
  plan: DecisionPlan;
  isFinalLook: boolean;
}

/** Positive-oriented t interval and resolved practical margin; no interval is reported below n=5. */
export function verdictFor({ diffs, metric, baseMean, plan }: VerdictInput) {
  const alphaLook = alphaPerLook(plan);
  const margin = metric.relative
    ? Math.max(metric.margin * Math.abs(baseMean), metric.minMargin ?? 0)
    : metric.margin;
  if (!Number.isFinite(margin) || margin < 0)
    throw new RangeError('resolved margin must be finite and nonnegative');
  const n = diffs.length;
  if (n < 5)
    return {
      verdict: 'DESCRIPTIVE' as PerfVerdict,
      lo: null,
      hi: null,
      n,
      alphaLook,
      margin,
      reason: 'Fewer than five independent replications.',
    };
  if (!plan.looks.includes(n))
    return {
      verdict: 'INCONCLUSIVE' as PerfVerdict,
      lo: null,
      hi: null,
      n,
      alphaLook,
      margin,
      reason: 'Not a preregistered replication look.',
    };
  if (diffs.some((value) => !Number.isFinite(value)))
    return {
      verdict: 'INCONCLUSIVE' as PerfVerdict,
      lo: null,
      hi: null,
      n,
      alphaLook,
      margin,
      reason: 'Nonfinite paired differences cannot support inference.',
    };
  const interval = pairedT(
    metric.better === 'lower' ? diffs.map((value) => -value) : diffs,
    alphaLook,
  );
  const lo = interval.lo!;
  const hi = interval.hi!;
  let verdict: PerfVerdict = 'INCONCLUSIVE';
  let reason = 'Interval crosses the noninferiority boundary.';
  if (hi < -margin) {
    verdict = 'REGRESSION';
    reason = 'Interval lies below the negative margin.';
  } else if (lo > margin) {
    verdict = 'IMPROVEMENT';
    reason = 'Interval lies above the positive margin.';
  } else if (lo > -margin && hi < margin) {
    verdict = 'EQUIVALENT';
    reason = 'Interval lies strictly within both margins.';
  } else if (lo > -margin) {
    verdict = 'NONINFERIOR';
    reason = 'Interval excludes regression beyond the margin.';
  }
  return { verdict, lo, hi, n, alphaLook, margin, reason };
}

/** A/A requires compatibility with zero and the practical margins; instability is declared at the final look. */
export function aaVerdict(
  input: VerdictInput,
): 'EQUIVALENT' | 'UNSTABLE' | 'INCONCLUSIVE' | 'DESCRIPTIVE' {
  const result = verdictFor(input);
  if (result.lo === null || result.hi === null)
    return result.verdict === 'DESCRIPTIVE' ? 'DESCRIPTIVE' : 'INCONCLUSIVE';
  const excludesZero = result.lo > 0 || result.hi < 0;
  const outsideMargin = result.lo < -result.margin || result.hi > result.margin;
  if (input.isFinalLook && (excludesZero || outsideMargin)) return 'UNSTABLE';
  if (!excludesZero && result.lo > -result.margin && result.hi < result.margin)
    return 'EQUIVALENT';
  return 'INCONCLUSIVE';
}

/** Stop once every preregistered metric has a resolved verdict. */
export function shouldStop(verdicts: readonly PerfVerdict[]): boolean {
  return (
    verdicts.length > 0 &&
    verdicts.every(
      (verdict) => verdict !== 'INCONCLUSIVE' && verdict !== 'DESCRIPTIVE',
    )
  );
}
