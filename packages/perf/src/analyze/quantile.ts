// Explicit percentile conventions for started and failure-ranked outcomes.

/** Percentile interpolation convention (NumPy type 7, inverse empirical CDF, or lower order statistic). */
export type QuantileMethod = 'linear' | 'nearest-rank' | 'lower';

function checkQ(q: number): void {
  if (!(q >= 0 && q <= 1)) throw new RangeError('q must be in [0, 1]');
}

/** Quantile of ascending sorted data; NaN for empty input, with q=0 selecting the minimum. */
export function quantile(
  sorted: readonly number[],
  q: number,
  method: QuantileMethod = 'linear',
): number {
  checkQ(q);
  if (sorted.length === 0) return Number.NaN;
  if (method === 'nearest-rank')
    return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const value = sorted[lower]!;
  if (method === 'lower' || lower === sorted.length - 1) return value;
  return value + (sorted[lower + 1]! - value) * (position - lower);
}

/** Labelled percentiles conditional on starting; null when no jobs started. */
export function conditionalPercentiles(
  waits: readonly number[],
  qs: readonly number[] = [0.5, 0.9, 0.95, 0.99],
): Record<string, number | null> {
  const sorted = [...waits].sort((a, b) => a - b);
  return Object.fromEntries(
    qs.map((q) => {
      checkQ(q);
      return [`p${q * 100}`, sorted.length === 0 ? null : quantile(sorted, q)];
    }),
  );
}

/** Inverse empirical CDF with every non-start after every finite wait; NaN for no outcomes. */
export function failureRanked(
  waits: readonly number[],
  failures: number,
  q: number,
): number | 'failure' {
  checkQ(q);
  if (!Number.isInteger(failures) || failures < 0)
    throw new RangeError('failures must be a nonnegative integer');
  const total = waits.length + failures;
  if (total === 0) return Number.NaN;
  const index = Math.max(0, Math.ceil(q * total) - 1);
  return index >= waits.length
    ? 'failure'
    : [...waits].sort((a, b) => a - b)[index]!;
}
