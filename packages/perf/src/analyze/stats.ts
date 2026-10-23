// Replication-level statistics and multiplicity adjustments.
import studentTQuantile from '@stdlib/stats-base-dists-t-quantile';
import { mulberry32 } from '../core/rng.ts';

/** Arithmetic mean; NaN for an empty sample. */
export function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Sample standard deviation (n − 1 denominator); NaN below two observations. */
export function sd(values: readonly number[]): number {
  if (values.length < 2) return Number.NaN;
  const center = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - center) ** 2, 0) /
      (values.length - 1),
  );
}

/** Student's t inverse CDF, supplied by stdlib and checked against SciPy. */
export function tQuantile(p: number, df: number): number {
  return studentTQuantile(p, df);
}

/** Two-sided Student interval over independent paired replication differences. */
export function pairedT(diffs: readonly number[], alpha: number) {
  if (!(alpha > 0 && alpha < 1))
    throw new RangeError('alpha must be between 0 and 1');
  const n = diffs.length;
  const center = mean(diffs);
  const deviation = sd(diffs);
  const se = deviation / Math.sqrt(n);
  const df = n - 1;
  const radius = n >= 2 ? tQuantile(1 - alpha / 2, df) * se : Number.NaN;
  return {
    n,
    mean: center,
    sd: deviation,
    se,
    df,
    lo: n < 2 ? null : center - radius,
    hi: n < 2 ? null : center + radius,
  };
}

/** Two-sided absolute-mean sign-flip test; Monte Carlo includes the observed assignment. */
export function signFlipTest(
  diffs: readonly number[],
  {
    exactUpTo = 16,
    iterations = 20_000,
    seed = 0,
  }: { exactUpTo?: number; iterations?: number; seed?: number } = {},
): number {
  if (diffs.some((value) => !Number.isFinite(value)))
    throw new RangeError('paired differences must be finite');
  if (diffs.length === 0) return 1;
  if (
    !Number.isInteger(exactUpTo) ||
    exactUpTo < 0 ||
    !Number.isInteger(iterations) ||
    iterations < 1
  ) {
    throw new RangeError(
      'exactUpTo must be nonnegative and iterations must be positive integers',
    );
  }
  const observed = Math.abs(mean(diffs));
  // Match SciPy's tolerance for numerically equal permutation statistics.
  const tolerance = 100 * Number.EPSILON * observed;
  const extreme = (sum: number) =>
    Math.abs(sum / diffs.length) >= observed - tolerance;
  if (diffs.length <= exactUpTo) {
    let count = 0;
    const visit = (index: number, sum: number): void => {
      if (index === diffs.length) {
        if (extreme(sum)) count++;
        return;
      }
      const value = diffs[index]!;
      visit(index + 1, sum + value);
      visit(index + 1, sum - value);
    };
    visit(0, 0);
    return count / 2 ** diffs.length;
  }
  const random = mulberry32(seed);
  let count = 1;
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (const value of diffs) sum += random() < 0.5 ? -value : value;
    if (extreme(sum)) count++;
  }
  return count / (iterations + 1);
}

function orderedPvalues(pvalues: readonly number[]) {
  if (pvalues.some((p) => !Number.isFinite(p) || p < 0 || p > 1))
    throw new RangeError('p-values must be in [0, 1]');
  return pvalues.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p);
}

/** Holm familywise-error adjusted p-values in original input order. */
export function holm(pvalues: readonly number[]): number[] {
  const adjusted = new Array<number>(pvalues.length);
  let previous = 0;
  orderedPvalues(pvalues).forEach(({ p, index }, rank) => {
    previous = Math.min(1, Math.max(previous, (pvalues.length - rank) * p));
    adjusted[index] = previous;
  });
  return adjusted;
}

/** Benjamini-Hochberg false-discovery-rate adjusted p-values in input order. */
export function benjaminiHochberg(pvalues: readonly number[]): number[] {
  const ordered = orderedPvalues(pvalues);
  const adjusted = new Array<number>(pvalues.length);
  let next = 1;
  for (let rank = ordered.length - 1; rank >= 0; rank--) {
    const { p, index } = ordered[rank]!;
    next = Math.min(next, (p * pvalues.length) / (rank + 1));
    adjusted[index] = next;
  }
  return adjusted;
}

/** Approximate two-sided MDE: (t[1−α/2] + t[power]) × sdDiff / √n; not noncentral-t power inversion. */
export function mde({
  sdDiff,
  n,
  alpha,
  power,
}: {
  sdDiff: number;
  n: number;
  alpha: number;
  power: number;
}): number {
  if (
    !Number.isInteger(n) ||
    n < 2 ||
    !Number.isFinite(sdDiff) ||
    sdDiff < 0 ||
    !(alpha > 0 && alpha < 1) ||
    !(power > 0.5 && power < 1)
  ) {
    throw new RangeError(
      'MDE requires n >= 2, finite nonnegative sdDiff, alpha in (0,1), power in (0.5,1)',
    );
  }
  return (
    ((tQuantile(1 - alpha / 2, n - 1) + tQuantile(power, n - 1)) * sdDiff) /
    Math.sqrt(n)
  );
}

/** Jain fairness index for nonnegative allocations; NaN for empty or all-zero inputs. */
export function jain(values: readonly number[]): number {
  if (values.some((value) => !Number.isFinite(value) || value < 0))
    throw new RangeError('allocations must be finite and nonnegative');
  const scale = values.reduce((largest, value) => Math.max(largest, value), 0);
  if (scale === 0) return Number.NaN;
  const normalized = values.map((value) => value / scale);
  const sum = normalized.reduce((total, value) => total + value, 0);
  return (
    sum ** 2 /
    (values.length * normalized.reduce((total, value) => total + value ** 2, 0))
  );
}
