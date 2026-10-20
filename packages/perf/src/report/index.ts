// Persist all benchmark report formats without losing non-finite JSON values.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunSummary } from '../analyze/summary.ts';
import { encode } from '../core/codec.ts';
import { renderMarkdown } from './markdown.ts';
import { renderCsv, renderComparisonsCsv } from './csv.ts';
import { renderHtml } from './html.ts';
/** Write JSON, Markdown, CSVs and optionally self-contained HTML to a directory. */
export async function writeReports(
  summary: RunSummary,
  dir: string,
  options: { html: boolean },
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const files: [string, string][] = [
    ['summary.json', encode(summary, 2) + '\n'],
    ['report.md', renderMarkdown(summary)],
    ['metrics.csv', renderCsv(summary)],
    ['comparisons.csv', renderComparisonsCsv(summary)],
  ];
  if (options.html) files.push(['report.html', renderHtml(summary)]);
  await Promise.all(
    files.map(([name, content]) => writeFile(join(dir, name), content, 'utf8')),
  );
}
