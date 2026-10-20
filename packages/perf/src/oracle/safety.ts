// Aggregate oracle results into an absolute safety status. Every violation class is a failure,
// including the inherited maxWait check-to-callback gap (C1); nothing is waived.
import type { SafetyReport, Violation, ViolationClass } from '../core/types.ts';

/** Combine independent oracle findings without converting missing evidence into a pass. */
export function safetyReport(
  violations: readonly Violation[],
  checked: readonly ViolationClass[],
  unverified: readonly ViolationClass[],
  sampleLimit = 20,
): SafetyReport {
  const counts: Partial<Record<ViolationClass, number>> = {};
  for (const v of violations) counts[v.class] = (counts[v.class] ?? 0) + 1;
  const status = violations.length
    ? 'FAIL'
    : unverified.length || !checked.length
      ? 'UNVERIFIED'
      : 'PASS';
  return {
    status,
    checked: [...new Set(checked)],
    unverified: [...new Set(unverified)],
    counts,
    samples: violations.slice(0, sampleLimit),
  };
}

/** Merge reports (e.g. reps of one arm): FAIL dominates, then UNVERIFIED. */
export function mergeSafety(reports: readonly SafetyReport[]): SafetyReport {
  const counts: Partial<Record<ViolationClass, number>> = {};
  for (const r of reports)
    for (const [k, v] of Object.entries(r.counts))
      counts[k as ViolationClass] =
        (counts[k as ViolationClass] ?? 0) + (v ?? 0);
  const status = reports.some((r) => r.status === 'FAIL')
    ? 'FAIL'
    : !reports.length ||
        reports.some(
          (r) =>
            r.status === 'UNVERIFIED' ||
            (!r.checked.length && r.status !== 'FAIL'),
        )
      ? 'UNVERIFIED'
      : 'PASS';
  const checked = [...new Set(reports.flatMap((r) => r.checked))];
  return {
    status,
    checked,
    unverified: [...new Set(reports.flatMap((r) => r.unverified))],
    counts,
    samples: reports.flatMap((r) => r.samples).slice(0, 20),
  };
}

/** One-line status text, e.g. `FAIL (maxwait-C1-check-before-deadline × 3)`. */
export function safetyText(r: SafetyReport): string {
  const parts = Object.entries(r.counts).map(([k, v]) => `${k} × ${v}`);
  if (r.status === 'FAIL')
    return parts.length
      ? `FAIL (${parts.join(', ')})`
      : 'FAIL (trial failed; see evidence)';
  if (r.status === 'UNVERIFIED')
    return r.unverified.length
      ? `UNVERIFIED (not checked: ${r.unverified.join(', ')})`
      : 'UNVERIFIED (no safety evidence)';
  return 'PASS';
}
