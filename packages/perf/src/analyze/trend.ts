// Soak and chaos analytics: least-squares slopes with t-intervals (leak detection) and
// throughput recovery after faults.
import { tQuantile } from './stats.ts';

export interface Slope {
  n: number;
  /** Units per hour. */
  slopePerHour: number;
  lo: number;
  hi: number;
}

/** OLS slope of y on t (ms) with a two-sided (1-alpha) t-interval, in y-units per hour. */
export function slope(
  points: readonly { t: number; y: number }[],
  alpha = 0.05,
): Slope | null {
  const n = points.length;
  if (n < 3) return null;
  const mt = points.reduce((s, p) => s + p.t, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sxx += (p.t - mt) ** 2;
    sxy += (p.t - mt) * (p.y - my);
  }
  if (sxx === 0) return null;
  const b = sxy / sxx;
  const a = my - b * mt;
  let sse = 0;
  for (const p of points) sse += (p.y - a - b * p.t) ** 2;
  const se = Math.sqrt(sse / (n - 2) / sxx);
  const h = tQuantile(1 - alpha / 2, n - 2) * se;
  const perHour = 3_600_000;
  return {
    n,
    slopePerHour: b * perHour,
    lo: (b - h) * perHour,
    hi: (b + h) * perHour,
  };
}

/** A leak is suspected when the slope interval excludes 0 and its lower bound exceeds the threshold. */
export function leakVerdict(
  s: Slope | null,
  thresholdPerHour: number,
): 'LEAK SUSPECTED' | 'NO LEAK DETECTED' | 'INSUFFICIENT DATA' {
  if (!s) return 'INSUFFICIENT DATA';
  return s.lo > thresholdPerHour ? 'LEAK SUSPECTED' : 'NO LEAK DETECTED';
}

/**
 * Time from the end of a fault until the start rate (in `binMs` bins) first returns to at least
 * `fraction` of the pre-fault rate. Null if it never recovers within the observed starts.
 */
export function recoveryMs(
  starts: readonly number[],
  window: { from: number; to: number },
  fault: { at: number; doneAt: number },
  binMs = 250,
  fraction = 0.9,
): { recoveryMs: number | null; preRatePerSec: number; dipRatePerSec: number } {
  const pre = starts.filter((t) => t >= window.from && t < fault.at).length;
  const preSpan = Math.max(1, fault.at - window.from);
  const preRate = (pre / preSpan) * 1000;
  let dip = Infinity;
  for (let b0 = fault.at; b0 < window.to; b0 += binMs) {
    const rate =
      (starts.filter((t) => t >= b0 && t < b0 + binMs).length / binMs) * 1000;
    dip = Math.min(dip, rate);
    if (b0 >= fault.doneAt && rate >= fraction * preRate)
      return {
        recoveryMs: b0 - fault.doneAt,
        preRatePerSec: preRate,
        dipRatePerSec: dip,
      };
  }
  return {
    recoveryMs: null,
    preRatePerSec: preRate,
    dipRatePerSec: Number.isFinite(dip) ? dip : 0,
  };
}
