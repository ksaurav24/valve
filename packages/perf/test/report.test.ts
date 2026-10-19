// Report contracts: safety precedence, escaping, reproducibility and raw evidence.
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CellSummary, RunSummary } from '../src/analyze/summary.ts';
import type { PerfVerdict } from '../src/core/types.ts';
import { renderMarkdown } from '../src/report/markdown.ts';
import { renderCsv, renderComparisonsCsv } from '../src/report/csv.ts';
import { renderHtml } from '../src/report/html.ts';
import { writeReports } from '../src/report/index.ts';
import { decode } from '../src/core/codec.ts';

const verdicts: PerfVerdict[] = [
  'REGRESSION',
  'IMPROVEMENT',
  'NONINFERIOR',
  'EQUIVALENT',
  'INCONCLUSIVE',
  'UNSTABLE',
  'DESCRIPTIVE',
];
function fixture(): RunSummary {
  const cell: CellSummary = {
    cellId: 'deadlines/"batch,one"',
    suite: 'deadlines',
    description: '<script>alert("x")</script>',
    tags: [],
    notes: ['Bound state recorded in trial payload.'],
    arms: ['base', 'aa', 'head'],
    metrics: Object.fromEntries(
      ['base', 'aa', 'head'].map((arm) => [
        arm,
        {
          waitP99: {
            n: 5,
            mean: 3,
            sd: 1,
            min: 1,
            median: 3,
            max: 5,
            values: [1, 2, 3, 4, 5],
          },
          cifP99: {
            n: 1,
            mean: Infinity,
            sd: null,
            min: Infinity,
            median: Infinity,
            max: Infinity,
            values: [Infinity, null],
          },
          goodput: {
            n: 0,
            mean: null,
            sd: null,
            min: null,
            median: null,
            max: null,
            values: [null],
          },
        },
      ]),
    ),
    outcomes: {
      head: {
        urgent: {
          completed: 30,
          failed: 1,
          expired: 2,
          aborted: 3,
          rejected: 4,
          unserved: 5,
        },
      },
    },
    safety: ['base', 'aa', 'head'].map((arm) => ({
      arm,
      status: 'FAIL',
      trials: 5,
      counts: { 'maxwait-C1-check-before-deadline': 2 },
      unverified: ['rate-bound'],
      samples: ['late callback'],
    })),
    comparisons: verdicts.map((verdict, i) => ({
      metric: 'waitP99',
      arm: i === 5 ? 'aa' : 'head',
      better: 'lower',
      n: 5,
      meanDiff: 1,
      lo: -1,
      hi: 3,
      alphaLook: 0.05 / 3,
      margin: 2,
      permutationP: 0.1,
      adjustedP: 0.2,
      verdict,
      reason: `reason, "${verdict}"\nnext`,
    })),
    invalidTrials: { head: 1 },
    aaVerdict: 'UNSTABLE',
  };
  return {
    runId: 'run-1',
    profile: 'targeted',
    tier: 'T3',
    createdAt: '2026-10-19T00:00:00Z',
    authoritative: false,
    fingerprintId: 'fp-1',
    fingerprint: { node: 'v22' },
    builds: {
      base: {
        label: 'base',
        gitSha: 'abc',
        dirty: false,
        packageDir: '/tmp/base',
        distSha256: 'sha256',
        files: {},
        lockSha256: 'lock',
        luaSha1: {},
        builtAt: '2026-10-19',
        node: 'v22',
      },
    },
    safety: 'FAIL',
    cells: [
      cell,
      {
        ...cell,
        cellId: 'gcra/backlog',
        suite: 'gcra',
        description: 'Backlog',
        safety: [
          {
            arm: 'base',
            status: 'UNVERIFIED',
            trials: 1,
            counts: {},
            unverified: ['lease-oversubscription'],
            samples: [],
          },
        ],
      },
    ],
    notExecuted: [{ what: 'soak', reason: 'budget' }],
    warnings: ['portable host'],
    durationSec: 123,
  };
}
describe('report renderers', () => {
  it('prints safety before performance, all verdicts and censoring labels', () => {
    const md = renderMarkdown(fixture());
    expect(md.indexOf('OVERALL SAFETY: FAIL')).toBeLessThan(
      md.indexOf('## Performance'),
    );
    expect(md).toContain('FAIL (C1 × 2)');
    expect(md).not.toContain('| PASS');
    for (const v of verdicts) expect(md).toContain(v);
    for (const text of [
      'NON-AUTHORITATIVE',
      'C1 maxWait violations are failures',
      'UNVERIFIED',
      'not reached (∞)',
      'conditional on starting',
      'CIF (Aalen-Johansen)',
      'Failure-ranked (conservative)',
      'not attainable',
      'harness floor',
      'nothing is subtracted',
      'Not executed',
      'soak: budget',
      'idealBound ratio',
    ])
      expect(md).toContain(text);
  });
  it('quotes CSV according to RFC4180 and preserves raw values', () => {
    const s = fixture();
    expect(renderCsv(s)).toContain('"deadlines/""batch,one"""');
    expect(renderCsv(s)).toContain('Infinity;');
    expect(renderCsv(s)).toContain('1;2;3;4;5');
    expect(renderComparisonsCsv(s)).toContain('"reason, ""REGRESSION""\nnext"');
    expect(renderCsv(s)).toContain('\r\n');
  });
  it('escapes HTML and supplies accessible self-contained plots and tables', () => {
    const html = renderHtml(fixture());
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<svg role="img"');
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
    expect(html).toContain('±margin band');
    expect(html.indexOf('OVERALL SAFETY')).toBeLessThan(
      html.indexOf('<h2>Performance'),
    );
    expect(html).not.toContain('src="http');
  });
  it('renders deterministically', () => {
    const s = fixture();
    for (const render of [
      renderMarkdown,
      renderHtml,
      renderCsv,
      renderComparisonsCsv,
    ])
      expect(render(s)).toBe(render(s));
  });
  it('writes every requested artifact and preserves Infinity in JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'valve-report-'));
    try {
      await writeReports(fixture(), dir, { html: true });
      for (const name of [
        'report.md',
        'metrics.csv',
        'comparisons.csv',
        'report.html',
      ])
        expect(
          (await readFile(join(dir, name), 'utf8')).length,
        ).toBeGreaterThan(0);
      const summary = decode<RunSummary>(
        await readFile(join(dir, 'summary.json'), 'utf8'),
      );
      expect(summary.cells[0]?.metrics.base?.cifP99?.mean).toBe(Infinity);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
