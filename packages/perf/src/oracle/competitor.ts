// Observable comparator contracts. Callback timestamps cannot prove the internal reservation
// clock of a third-party scheduler, so rate categories remain explicitly UNVERIFIED even when
// these coarse envelopes pass. Never replay Valve's GCRA state against another library.
import type {
  CellSpec,
  JobRecord,
  Violation,
  ViolationClass,
} from '../core/types.ts';

/** Evaluate only observable guarantees supported by the selected competitor's declared contract. */
export function competitorContract(
  cell: CellSpec,
  jobs: readonly JobRecord[],
): {
  violations: Violation[];
  unverified: ViolationClass[];
  notes: string[];
} {
  if (cell.library === 'valve' || cell.library === 'identity')
    return { violations: [], unverified: [], notes: [] };
  const rule = cell.rules?.[0];
  if (!rule) return { violations: [], unverified: [], notes: [] };
  const unverified: ViolationClass[] = [
    rule.algorithm === 'fixed-window' ? 'window-bound' : 'rate-bound',
  ];
  const notes = [
    'Comparator callback-envelope checks are observable diagnostics; exact reservation/window clocks are unverified. Window anchors and timer jitter differ by library.',
  ];
  const starts = jobs.filter((j) => j.st >= 0).sort((a, b) => a.st - b.st);
  const violations: Violation[] = [];
  if (cell.category === 'L2' || cell.category === 'D2') {
    const spacing = rule.intervalMs / rule.limit;
    const tolerance =
      cell.library === 'bottleneck'
        ? 3 + (cell.category === 'D2' ? 0.5 : 0)
        : 1;
    for (let i = 1; i < starts.length; i++) {
      const gap = starts[i]!.st - starts[i - 1]!.st;
      if (gap < spacing - tolerance) {
        violations.push({
          class: 'contract',
          detail: `${cell.library}: observed start gap ${gap.toFixed(3)}ms below ${spacing}ms pacing target minus declared ${tolerance}ms timer/alignment tolerance`,
          magnitude: spacing - gap,
        });
        break;
      }
    }
    notes.push(
      `Observed pacing tolerance: ${tolerance}ms; raw minimum spacing is reported without correction.`,
    );
  } else if (cell.category === 'L3' || cell.category === 'D3') {
    // Any interval may straddle two of the library's own quota windows. This deliberately
    // does not assume Valve's epoch-aligned window phase for p-queue or Bottleneck.
    let lo = 0,
      cost = 0;
    for (let hi = 0; hi < starts.length; hi++) {
      cost += starts[hi]!.c;
      while (starts[hi]!.st - starts[lo]!.st >= rule.intervalMs)
        cost -= starts[lo++]!.c;
      if (cost > 2 * rule.limit) {
        violations.push({
          class: 'contract',
          detail: `${cell.library}: ${cost} callback cost inside ${rule.intervalMs}ms exceeds two-window envelope ${2 * rule.limit}; exact window phase is unverified`,
          magnitude: cost - 2 * rule.limit,
        });
        break;
      }
    }
  }
  return { violations, unverified, notes };
}
