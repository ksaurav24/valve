// Self-contained accessible HTML reports and SVG paired-difference plots.
import type { CellSummary, RunSummary } from '../analyze/summary.ts';
import { renderMarkdown } from './markdown.ts';
import { formatNumber, metricLabel } from './format.ts';

const esc = (s: unknown): string =>
  String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
function plots(cell: CellSummary): string {
  return [...new Set(cell.comparisons.map((c) => c.metric))]
    .sort()
    .map((metric) => {
      const arms = Object.keys(cell.metrics).sort();
      const comparisons = cell.comparisons
        .filter((c) => c.metric === metric)
        .sort((a, b) => a.arm.localeCompare(b.arm));
      const values = arms
        .flatMap((a) => cell.metrics[a]?.[metric]?.values ?? [])
        .filter((v): v is number => v !== null && Number.isFinite(v));
      const diffs = comparisons
        .flatMap((c) => [c.meanDiff, c.lo, c.hi, -c.margin, c.margin])
        .filter((v): v is number => v !== null && Number.isFinite(v));
      const scale = (xs: number[]) => {
        const lo = Math.min(0, ...xs),
          hi = Math.max(0, ...xs);
        return (x: number) => 180 + ((x - lo) / (hi - lo || 1)) * 560;
      };
      const rawX = scale(values),
        diffX = scale(diffs);
      const height = 100 + (arms.length + comparisons.length) * 34;
      const shapes: string[] = [
        '<text x="12" y="22">Per-rep raw absolutes</text>',
      ];
      arms.forEach((a, i) => {
        const y = 50 + i * 34;
        const vs = cell.metrics[a]?.[metric]?.values ?? [];
        shapes.push(`<text x="12" y="${y}">${esc(a)}</text>`);
        vs.forEach((v, rep) => {
          if (v !== null && Number.isFinite(v))
            shapes.push(
              `<circle cx="${rawX(v)}" cy="${y - 4 + ((rep % 3) - 1) * 4}" r="3"><title>${esc(a)} rep ${rep + 1}: ${esc(formatNumber(v))}</title></circle>`,
            );
        });
        const missing = vs.filter((v) => v === null || !Number.isFinite(v));
        if (missing.length)
          shapes.push(
            `<text x="760" y="${y}">${esc(missing.map((v) => formatNumber(v)).join(', '))}</text>`,
          );
      });
      const offset = 70 + arms.length * 34;
      shapes.push(
        `<text x="12" y="${offset}">Paired arm − base: interval and ±margin band (separate scale)</text>`,
      );
      comparisons.forEach((c, i) => {
        const y = offset + 24 + i * 34;
        shapes.push(`<text x="12" y="${y}">${esc(c.arm)}</text>`);
        if (Number.isFinite(c.margin))
          shapes.push(
            `<rect class="margin" x="${diffX(-c.margin)}" y="${y - 12}" width="${Math.abs(diffX(c.margin) - diffX(-c.margin))}" height="18"/>`,
          );
        shapes.push(`<path class="zero" d="M${diffX(0)} ${y - 14}v22"/>`);
        if (
          c.lo !== null &&
          c.hi !== null &&
          Number.isFinite(c.lo) &&
          Number.isFinite(c.hi)
        )
          shapes.push(`<path d="M${diffX(c.lo)} ${y - 4}H${diffX(c.hi)}"/>`);
        if (c.meanDiff !== null && Number.isFinite(c.meanDiff))
          shapes.push(
            `<circle cx="${diffX(c.meanDiff)}" cy="${y - 4}" r="4"/>`,
          );
        shapes.push(
          `<text x="760" y="${y}">${esc(formatNumber(c.meanDiff))} [${esc(formatNumber(c.lo))}, ${esc(formatNumber(c.hi))}] ±${esc(formatNumber(c.margin))}</text>`,
        );
      });
      return `<figure><figcaption>${esc(metricLabel(metric))}</figcaption><svg role="img" aria-label="${esc(metricLabel(metric))}: raw rep values and paired difference intervals with margin bands" viewBox="0 0 1200 ${height}">${shapes.join('')}</svg></figure>`;
    })
    .join('');
}
/** Render a standalone HTML report, readable without scripts or external assets. */
export function renderHtml(summary: RunSummary): string {
  // Markdown is already text-escaped; only our generated structural markup is interpreted.
  const lines = renderMarkdown(summary).split('\n');
  const body: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('| ')) {
      const rows: string[][] = [];
      while (lines[i]?.startsWith('| ')) {
        rows.push((lines[i] ?? '').slice(2, -2).split(' | '));
        i++;
      }
      i--;
      body.push(
        `<div class="table"><table><thead><tr>${(rows[0] ?? []).map((v) => `<th scope="col">${v}</th>`).join('')}</tr></thead><tbody>${rows
          .slice(2)
          .map(
            (r) =>
              `<tr>${r.map((v, j) => (j === 0 ? `<th scope="row">${v}</th>` : `<td>${v}</td>`)).join('')}</tr>`,
          )
          .join('')}</tbody></table></div>`,
      );
    } else if (/^#{1,4} /.test(line)) {
      const level = line.indexOf(' ');
      body.push(`<h${level}>${line.slice(level + 1)}</h${level}>`);
    } else if (line)
      body.push(
        `<p${line.startsWith('> ') ? ' class="banner"' : ''}>${line.replace(/^> /, '')}</p>`,
      );
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(summary.runId)} - Valve benchmark</title><style>:root{color-scheme:light dark}body{font:15px system-ui;max-width:1400px;margin:auto;padding:24px;line-height:1.5}h2{border-bottom:1px solid GrayText;padding-top:20px}.banner{border:2px solid #bd7900;padding:16px}.table{overflow:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{border:1px solid GrayText;padding:7px;text-align:left}svg{width:100%;min-width:700px;fill:currentColor}svg text{font:12px system-ui}svg path{stroke:currentColor;fill:none}.margin{fill:#6789ab;opacity:.25}.zero{stroke-dasharray:3 3}figure{overflow:auto;margin:20px 0}figcaption{font-weight:bold}</style></head><body><main>${body.join('\n')}<h2>Plots</h2>${[
    ...summary.cells,
  ]
    .sort((a, b) => a.cellId.localeCompare(b.cellId))
    .map((c) => `<section><h3>${esc(c.cellId)}</h3>${plots(c)}</section>`)
    .join('')}</main></body></html>\n`;
}
