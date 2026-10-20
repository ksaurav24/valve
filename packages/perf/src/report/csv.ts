// RFC4180 exports preserve stored numbers, including non-finite labels.
import type { RunSummary } from '../analyze/summary.ts';

const scalar = (v: unknown): string =>
  v === null || v === undefined ? '' : String(v);
const quote = (v: unknown): string => {
  const s = scalar(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
const csv = (rows: unknown[][]): string =>
  rows.map((row) => row.map(quote).join(',')).join('\r\n') + '\r\n';
/** Render one raw scalar-statistics row per cell, arm and metric. */
export function renderCsv(summary: RunSummary): string {
  const rows: unknown[][] = [
    [
      'runId',
      'cell',
      'suite',
      'arm',
      'metric',
      'n',
      'mean',
      'sd',
      'min',
      'median',
      'max',
      'values',
    ],
  ];
  for (const cell of [...summary.cells].sort((a, b) =>
    a.cellId.localeCompare(b.cellId),
  ))
    for (const arm of Object.keys(cell.metrics).sort())
      for (const metric of Object.keys(cell.metrics[arm] ?? {}).sort()) {
        const s = cell.metrics[arm]?.[metric];
        if (s)
          rows.push([
            summary.runId,
            cell.cellId,
            cell.suite,
            arm,
            metric,
            s.n,
            s.mean,
            s.sd,
            s.min,
            s.median,
            s.max,
            s.values.map(scalar).join(';'),
          ]);
      }
  return csv(rows);
}
/** Render paired differences, inference settings and verdicts in stored units. */
export function renderComparisonsCsv(summary: RunSummary): string {
  const rows: unknown[][] = [
    [
      'runId',
      'cell',
      'suite',
      'metric',
      'arm',
      'better',
      'n',
      'meanDiff',
      'lo',
      'hi',
      'margin',
      'alphaLook',
      'permutationP',
      'adjustedP',
      'verdict',
      'reason',
    ],
  ];
  for (const c of [...summary.cells].sort((a, b) =>
    a.cellId.localeCompare(b.cellId),
  ))
    for (const x of [...c.comparisons].sort(
      (a, b) => a.metric.localeCompare(b.metric) || a.arm.localeCompare(b.arm),
    ))
      rows.push([
        summary.runId,
        c.cellId,
        c.suite,
        x.metric,
        x.arm,
        x.better,
        x.n,
        x.meanDiff,
        x.lo,
        x.hi,
        x.margin,
        x.alphaLook,
        x.permutationP,
        x.adjustedP,
        x.verdict,
        x.reason,
      ]);
  return csv(rows);
}
