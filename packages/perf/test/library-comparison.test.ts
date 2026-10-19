import { describe, expect, it } from 'vitest';
import { aggregateLibraries } from '../src/analyze/libs.ts';
import type { RunSummary } from '../src/analyze/summary.ts';
import { cellHash } from '../src/core/manifest.ts';
import type { CellSpec, DecisionPlan, TrialRecord } from '../src/core/types.ts';
import { estimate, loadCalibration } from '../src/plan/budget.ts';
import {
  libraryCategory,
  libraryMetricsFor,
  libsCells,
} from '../src/plan/libs.ts';
import { seedFor } from '../src/supervisor/runner.ts';
import { preparePlan } from '../src/tiers/run.ts';

const meta: RunSummary = {
  runId: 'libraries',
  profile: 'libs',
  tier: 'libs',
  createdAt: '2026-10-19T00:00:00Z',
  authoritative: false,
  fingerprintId: 'fp',
  fingerprint: {},
  builds: {},
  notExecuted: [{ what: 'L2/p-limit', reason: 'N/A' }],
  warnings: ['portable'],
  durationSec: 1,
  safety: 'PASS',
  cells: [],
};
function rowsFor(cells: CellSpec[], reps = 5): TrialRecord[] {
  return cells.flatMap((cell) =>
    Array.from({ length: reps }, (_, rep) =>
      (cell.library === 'valve' ? ['base', 'aa'] : ['base']).map((arm) => ({
        runId: 'libraries',
        trialId: `${cell.id}/${arm}/${rep}`,
        cellId: cell.id,
        cellHash: cellHash(cell),
        arm,
        rep,
        seed: seedFor(42, cell, rep),
        attempt: 1,
        fingerprintId: 'fp',
        buildDistSha256: 'dist',
        startedAt: meta.createdAt,
        durationSec: 1,
        status: 'ok' as const,
        metrics: {
          usefulStartsPerSec: cell.library === 'valve' ? 100 : 120,
          appCpuUsPerGrant: 10,
          'backlog.waitP99': 1,
          'open.waitP99': 1,
        },
        outcomes: { backlog: { completed: 100 } },
        safety: {
          status: 'PASS' as const,
          checked: [],
          unverified: [],
          counts: {},
          samples: [],
        },
        resources: { valid: true, authoritative: false, reasons: [] },
      })),
    ).flat(),
  );
}
function analyze(cells: CellSpec[], rows = rowsFor(cells), reps = 5) {
  const plan: DecisionPlan = {
    metrics: [
      ...new Map(
        cells.flatMap(libraryMetricsFor).map((m) => [m.metric, m]),
      ).values(),
    ],
    looks: [reps],
    alpha: 0.05,
  };
  return aggregateLibraries(rows, cells, plan, meta);
}

describe('bounded library comparisons', () => {
  it('plans Valve A/A only, preregisters metrics and estimates the actual trial count', () => {
    const plan = preparePlan({ tier: 'libs', categories: ['L1'], reps: 5 });
    expect(plan.armNames).toEqual(['base', 'aa']);
    expect(plan.audit).toBe(false);
    expect(plan.looks).toEqual([5]);
    expect(plan.decision.metrics.map((m) => m.metric)).toEqual([
      'usefulStartsPerSec',
      'appCpuUsPerGrant',
      'backlog.waitP99',
    ]);
    expect(plan.decision.metrics.every((m) => m.relative && m.margin > 0)).toBe(
      true,
    );
    const trials = plan.cells.flatMap((cell) =>
      Array.from({ length: 5 * (cell.library === 'valve' ? 2 : 1) }, () => ({
        cell,
      })),
    );
    expect(trials).toHaveLength(60);
    expect(plan.estimateSec).toBe(
      estimate(trials, loadCalibration(), false).withRetriesSeconds,
    );
    expect(
      plan.cells.every(
        (c) =>
          c.timing.windowMs === 100 &&
          c.timing.warmupMs === 100 &&
          c.timing.drainMs === 100,
      ),
    ).toBe(true);
    expect(
      preparePlan({
        tier: 'libs',
        categories: ['L1-noop'],
        windowMs: 200,
      }).cells.every((c) => c.timing.windowMs === 200),
    ).toBe(true);
    const l5 = libsCells('matrix', ['L5']).cells;
    expect(l5.every((c) => c.workload.abort?.queuedOnly)).toBe(true);
    expect(libraryMetricsFor(l5[0]!).at(-1)?.metric).toBe('open.waitP99');
  });

  it('pairs libraries by category, preserves raw identities and keeps L1-noop distinct', () => {
    const cells = libsCells('matrix', ['L1']).cells;
    const rows = rowsFor(cells);
    const before = structuredClone(rows);
    const report = analyze(cells, rows);
    expect(report.cells.map((c) => c.cellId)).toEqual([
      'libs/L1',
      'libs/L1-noop',
    ]);
    expect(rows).toEqual(before);
    for (const cell of report.cells) {
      expect(cell.arms).toEqual(
        expect.arrayContaining([
          'valve',
          'aa',
          'p-limit',
          'p-queue',
          'bottleneck',
          'identity',
        ]),
      );
      expect(cell.aaVerdict).toBe('EQUIVALENT');
      expect(
        cell.comparisons.find(
          (c) => c.arm === 'p-limit' && c.metric === 'usefulStartsPerSec',
        ),
      ).toMatchObject({
        n: 5,
        meanDiff: 20,
        lo: 20,
        hi: 20,
        verdict: 'IMPROVEMENT',
      });
      expect(cell.comparisons.some((c) => c.arm === 'identity')).toBe(false);
      expect(cell.metrics.valve?.usefulStartsPerSec?.mean).toBe(100);
      expect(cell.metrics.identity?.usefulStartsPerSec?.mean).toBe(120);
      expect(cell.notes.join(' ')).toContain('p-limit 7.3.3');
      expect(cell.notes.join(' ')).toContain('p-queue 9.3.3');
      expect(cell.notes.join(' ')).toContain('bottleneck 2.19.5');
      expect(cell.notes.join(' ')).toContain('conditional on starting');
    }
    expect(report.notExecuted).toEqual(meta.notExecuted);
    expect(report.warnings).toEqual(meta.warnings);
    expect(libraryCategory(cells.find((c) => c.id.includes('L1-noop'))!)).toBe(
      'L1-noop',
    );
  });

  it('withholds inference below five pairs and on unstable A/A', () => {
    const cells = libsCells('matrix', ['L1-noop']).cells;
    expect(
      analyze(cells, rowsFor(cells, 1), 1).cells[0]?.comparisons.every(
        (c) => c.verdict === 'DESCRIPTIVE' && c.lo === null,
      ),
    ).toBe(true);
    const rows = rowsFor(cells);
    for (const row of rows)
      if (row.arm === 'aa') row.metrics.usefulStartsPerSec = 150;
    const report = analyze(cells, rows).cells[0]!;
    expect(report.aaVerdict).toBe('UNSTABLE');
    expect(
      report.comparisons
        .filter((c) => c.arm !== 'aa')
        .every((c) => c.verdict === 'INCONCLUSIVE'),
    ).toBe(true);
  });

  it('leaves approximate L4 Bottleneck as raw diagnostic only', () => {
    const cells = libsCells('matrix', ['L4']).cells;
    const report = analyze(cells).cells[0]!;
    expect(report.metrics.bottleneck?.usefulStartsPerSec?.mean).toBe(120);
    expect(report.comparisons.some((c) => c.arm === 'bottleneck')).toBe(false);
    expect(report.notes.join(' ')).toContain('approximate');
    expect(report.aaVerdict).toBe('EQUIVALENT');
  });

  it('does not expect unsupported arms, and preserves failure and unverified evidence', () => {
    const cells = libsCells('matrix', ['L2']).cells;
    const rows = rowsFor(cells);
    let report = analyze(cells, rows);
    expect(report.cells[0]?.arms).not.toContain('p-limit');
    expect(
      report.cells[0]?.comparisons.find((c) => c.arm === 'bottleneck')?.verdict,
    ).toBe('IMPROVEMENT');
    const external = rows.find((r) => r.cellId.endsWith('/bottleneck'))!;
    external.safety = {
      status: 'UNVERIFIED',
      checked: [],
      unverified: ['rate-bound'],
      counts: {},
      samples: [],
    };
    report = analyze(cells, rows);
    expect(report.safety).toBe('UNVERIFIED');
    expect(
      report.cells[0]?.safety.find((s) => s.arm === 'bottleneck')?.unverified,
    ).toEqual(['rate-bound']);
    external.status = 'failed';
    external.error = 'execution failed';
    external.safety = {
      status: 'FAIL',
      checked: ['contract'],
      unverified: [],
      counts: { contract: 1 },
      samples: [{ class: 'contract', detail: 'bad contract' }],
    };
    report = analyze(cells, rows);
    expect(report.safety).toBe('FAIL');
    expect(
      report.cells[0]?.safety.find((s) => s.arm === 'bottleneck'),
    ).toMatchObject({ status: 'FAIL', counts: { contract: 1 } });
    expect(
      report.cells[0]?.comparisons
        .filter((c) => c.arm !== 'aa')
        .every((c) => c.verdict !== 'IMPROVEMENT'),
    ).toBe(true);
    expect(
      aggregateLibraries(
        [],
        cells,
        { metrics: [], looks: [5], alpha: 0.05 },
        { ...meta, safety: 'FAIL' },
      ).safety,
    ).toBe('FAIL');
  });

  it('rejects mismatched workload seeds instead of manufacturing pairs', () => {
    const cells = libsCells('matrix', ['L1-noop']).cells;
    const rows = rowsFor(cells);
    rows.find((r) => r.cellId.endsWith('/p-limit'))!.seed++;
    expect(() => analyze(cells, rows)).toThrow(
      'incompatible paired trial identity',
    );
  });
});
