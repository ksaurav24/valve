// Client-side oracles, valid in every arm (instrumented or not): start after abort, callback after
// maxWait (classified C1 vs late grant), lost jobs, and callback overlap above a concurrency limit.
import { Outcome, type JobRecord, type Violation } from '../core/types.ts';

export interface ClientCheckOptions {
  /** Workers whose jobs are excluded from lost-job checks (deliberately killed). */
  killedWorkers?: ReadonlySet<number>;
  /** Fleet-wide concurrency limit to check callback overlap against (global leases, D1). */
  fleetConcurrency?: number;
  /** Per-worker concurrency limit (local concurrency, L1). */
  localConcurrency?: number;
  /** Cross-process clock alignment tolerance for overlap checks, ms. */
  alignTolMs?: number;
}

export interface ClientCheckResult {
  violations: Violation[];
  maxOverlapFleet: number;
  maxOverlapLocal: number;
  deadlineChecked: number;
  worstLateMs: number;
  lateByValveClock: number;
}

/** Max simultaneous [start, end) intervals after shrinking each by `tol` on both sides. */
export function maxOverlap(
  intervals: readonly [number, number][],
  tol = 0,
): number {
  const ev: [number, number][] = [];
  for (const [a, b] of intervals) {
    const s = a + tol;
    const e = b - tol;
    if (e > s) ev.push([s, 1], [e, -1]);
  }
  ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of ev) max = Math.max(max, (cur += d));
  return max;
}

export function checkClient(
  jobs: readonly JobRecord[],
  options: ClientCheckOptions = {},
): ClientCheckResult {
  const violations: Violation[] = [];
  let deadlineChecked = 0;
  let worstLateMs = 0;
  let lateByValveClock = 0;
  for (const j of jobs) {
    const started = j.st >= 0;
    if (started && j.ab >= 0 && j.ab < j.st)
      violations.push({
        class: 'start-after-abort',
        detail: `w${j.w}#${j.i}: callback ${(j.st - j.ab).toFixed(3)}ms after abort`,
        magnitude: j.st - j.ab,
        at: j.st,
        worker: j.w,
      });
    if (started && j.mw >= 0) {
      deadlineChecked++;
      const late = j.st - j.sa - j.mw;
      if (late > 0) {
        worstLateMs = Math.max(worstLateMs, late);
        const deadline = j.sa + j.mw;
        const cls =
          j.rp >= 0 && j.rp < deadline
            ? 'maxwait-C1-check-before-deadline'
            : 'maxwait-late-grant';
        violations.push({
          class: cls,
          detail: `w${j.w}#${j.i}: callback ${late.toFixed(3)}ms after maxWait ${j.mw}ms (reply ${j.rp >= 0 ? (j.rp - deadline).toFixed(3) : '?'}ms vs deadline)`,
          magnitude: late,
          at: j.st,
          worker: j.w,
        });
      }
      if (j.sdStart - j.sd > j.mw) lateByValveClock++;
    }
    if (j.o === Outcome.pending && !options.killedWorkers?.has(j.w))
      violations.push({
        class: 'lost-job',
        detail: `w${j.w}#${j.i}: no terminal outcome`,
        worker: j.w,
      });
  }
  const tol = options.alignTolMs ?? 0.5;
  const intervals = jobs
    .filter((j) => j.st >= 0 && j.en >= 0)
    .map((j) => [j.st, j.en] as [number, number]);
  const maxOverlapFleet = maxOverlap(intervals, tol);
  if (
    options.fleetConcurrency !== undefined &&
    maxOverlapFleet > options.fleetConcurrency
  )
    violations.push({
      class: 'lease-oversubscription',
      detail: `client-observed ${maxOverlapFleet} concurrent callbacks > fleet limit ${options.fleetConcurrency} (±${tol}ms alignment)`,
      magnitude: maxOverlapFleet - options.fleetConcurrency,
    });
  let maxOverlapLocal = 0;
  const byWorker = new Map<number, [number, number][]>();
  for (const j of jobs)
    if (j.st >= 0 && j.en >= 0)
      (byWorker.get(j.w) ?? byWorker.set(j.w, []).get(j.w)!).push([j.st, j.en]);
  for (const [w, list] of byWorker) {
    const m = maxOverlap(list, 0.001);
    maxOverlapLocal = Math.max(maxOverlapLocal, m);
    if (options.localConcurrency !== undefined && m > options.localConcurrency)
      violations.push({
        class: 'contract',
        detail: `w${w}: ${m} concurrent callbacks > local limit ${options.localConcurrency}`,
        magnitude: m - options.localConcurrency,
        worker: w,
      });
  }
  return {
    violations,
    maxOverlapFleet,
    maxOverlapLocal,
    deadlineChecked,
    worstLateMs,
    lateByValveClock,
  };
}
