// Deterministic, safety-first human-readable benchmark report.
import type { RunSummary } from '../analyze/summary.ts';
import { encode } from '../core/codec.ts';
import { formatNumber as num, formatMetric, metricLabel } from './format.ts';

const escape = (s: unknown): string =>
  String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '&#124;')
    .replaceAll('\r', ' ')
    .replaceAll('\n', '<br>');
const table = (headers: string[], rows: unknown[][]): string =>
  [headers, headers.map(() => '---'), ...rows]
    .map((r) => `| ${r.map(escape).join(' | ')} |`)
    .join('\n');
/** Render a complete safety-first Markdown report with raw absolute statistics. */
export function renderMarkdown(s: RunSummary): string {
  const cells = [...s.cells].sort((a, b) => a.cellId.localeCompare(b.cellId));
  const out = [
    `# Valve benchmark: ${escape(s.runId)} / ${escape(s.profile)} / ${escape(s.tier)}`,
  ];
  if (!s.authoritative)
    out.push(
      '> NON-AUTHORITATIVE RUN - portable results; environment isolation requirements were not met.',
    );
  out.push(
    '## Provenance',
    `Fingerprint: ${escape(s.fingerprintId)}; Node: ${escape(s.fingerprint.node ?? 'see build identities')}; Created: ${escape(s.createdAt)}; Duration: ${num(s.durationSec)} s`,
    table(
      ['Arm', 'Label', 'gitSha', 'distSha256', 'Dirty', 'Node'],
      Object.keys(s.builds)
        .sort()
        .map((arm) => {
          const b = s.builds[arm]!;
          return [arm, b.label, b.gitSha, b.distSha256, b.dirty, b.node];
        }),
    ),
    `Environment fingerprint: ${escape(encode(s.fingerprint))}`,
  );
  out.push(
    `## OVERALL SAFETY: ${s.safety}`,
    'C1 maxWait violations are failures. A known C1 defect is labelled KNOWN DEFECT REPRODUCED, never a passing result.',
    table(
      [
        'Cell',
        'Arm',
        'Safety',
        'Trials',
        'Violation counts',
        'UNVERIFIED classes',
        'Samples',
      ],
      cells.flatMap((c) =>
        [...c.safety]
          .sort((a, b) => a.arm.localeCompare(b.arm))
          .map((a) => {
            const c1 = a.counts['maxwait-C1-check-before-deadline'] ?? 0;
            return [
              c.cellId,
              a.arm,
              `${a.status}${c1 ? ` (C1 × ${c1}) - KNOWN DEFECT REPRODUCED` : ''}`,
              a.trials,
              Object.keys(a.counts)
                .sort()
                .map((k) => `${k}: ${a.counts[k as keyof typeof a.counts]}`)
                .join('; ') || 'none',
              [...a.unverified].sort().join('; ') || 'none',
              a.samples.join('; '),
            ];
          }),
      ),
    ),
  );
  out.push(
    '## Performance',
    'Raw absolutes are reported. Identity adapter rows are the harness floor; nothing is subtracted. Means ± sample SD summarize independent reps; n is the measurable rep count.',
  );
  for (const c of cells) {
    out.push(
      `### ${escape(c.cellId)} (${escape(c.suite)})`,
      escape(c.description),
    );
    const metrics = [
      ...new Set(Object.values(c.metrics).flatMap((m) => Object.keys(m))),
    ].sort();
    const arms = [...new Set([...c.arms, ...Object.keys(c.metrics)])].sort();
    out.push(
      table(
        ['Arm', ...metrics.map(metricLabel)],
        arms.map((arm) => [
          arm === 'identity' ? 'identity (harness floor)' : arm,
          ...metrics.map((key) => {
            const m = c.metrics[arm]?.[key];
            return m
              ? `${formatMetric(m.mean, key)} ± ${formatMetric(m.sd, key)} (n=${m.n})`
              : '-';
          }),
        ]),
      ),
    );
    out.push(
      '#### Outcome counts',
      table(
        [
          'Arm',
          'Cohort',
          'completed',
          'failed',
          'expired',
          'aborted',
          'rejected',
          'unserved',
        ],
        Object.keys(c.outcomes)
          .sort()
          .flatMap((arm) =>
            Object.keys(c.outcomes[arm] ?? {})
              .sort()
              .map((cohort) => [
                arm,
                cohort,
                ...[
                  'completed',
                  'failed',
                  'expired',
                  'aborted',
                  'rejected',
                  'unserved',
                ].map((k) => c.outcomes[arm]?.[cohort]?.[k] ?? 0),
              ]),
          ),
      ),
    );
    out.push(
      '#### Comparisons (paired arm − base; stored metric units)',
      table(
        [
          'Metric',
          'Arm',
          'n',
          'Mean difference',
          'Interval',
          '± margin',
          'Alpha per look',
          'p',
          'Adjusted p',
          'Verdict',
          'Reason',
        ],
        [...c.comparisons]
          .sort(
            (a, b) =>
              a.metric.localeCompare(b.metric) || a.arm.localeCompare(b.arm),
          )
          .map((x) => [
            metricLabel(x.metric),
            x.arm,
            x.n,
            num(x.meanDiff),
            x.lo === null || x.hi === null
              ? '-'
              : `[${num(x.lo)}, ${num(x.hi)}]`,
            num(x.margin),
            num(x.alphaLook),
            num(x.permutationP),
            num(x.adjustedP),
            x.verdict,
            x.reason,
          ]),
      ),
      `A/A verdict: ${c.aaVerdict ?? 'not available'}`,
      `Resource-invalid trials: ${
        Object.keys(c.invalidTrials)
          .sort()
          .map((a) => `${escape(a)}=${c.invalidTrials[a]}`)
          .join('; ') || 'none'
      }`,
    );
    for (const note of c.notes) out.push(`- ${escape(note)}`);
  }
  out.push(
    '## Notes',
    '- Bounds are not attainable: zero RTT, timer error and CPU cost are assumed. Bound input state is not exposed by RunSummary; consult the trial/manifest evidence.',
    '- Finite closed-loop demand has no idealBound ratio: its denominator is not exogenous.',
    '- Wait: conditional on starting. CIF (Aalen-Johansen) accounts for competing events. Failure-ranked (conservative) treats failures as infinite waits.',
    '## Not executed',
    ...(s.notExecuted.length
      ? [...s.notExecuted]
          .sort((a, b) => a.what.localeCompare(b.what))
          .map((x) => `- ${escape(x.what)}: ${escape(x.reason)}`)
      : ['None.']),
    '## Warnings',
    ...(s.warnings.length
      ? s.warnings.map((w) => `- ${escape(w)}`)
      : ['None.']),
  );
  return out.join('\n\n') + '\n';
}
