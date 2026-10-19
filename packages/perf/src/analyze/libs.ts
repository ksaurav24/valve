// Analysis identities group matched workloads; persisted execution identities stay intact.
import { readFileSync } from 'node:fs';
import { cellHash } from '../core/manifest.ts';
import type { CellSpec, DecisionPlan, TrialRecord } from '../core/types.ts';
import { libraryCategory, libraryMetricsFor } from '../plan/libs.ts';
import { aggregate } from './aggregate.ts';
import { holm } from './stats.ts';
import type { RunSummary } from './summary.ts';

const dependencies = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).devDependencies as Record<string, string>;
const valveVersion = (
  JSON.parse(
    readFileSync(
      new URL('../../../valve/package.json', import.meta.url),
      'utf8',
    ),
  ) as { version: string }
).version;
const versions = `Library versions: valve ${valveVersion} (build identity recorded); p-limit ${dependencies['p-limit']}; p-queue ${dependencies['p-queue']}; bottleneck ${dependencies.bottleneck}; identity harness floor.`;

export function aggregateLibraries(
  rows: readonly TrialRecord[],
  cells: readonly CellSpec[],
  plan: DecisionPlan,
  original: RunSummary,
): RunSummary {
  const categories = new Map<string, CellSpec[]>();
  for (const cell of cells) {
    const category = libraryCategory(cell);
    const group = categories.get(category) ?? [];
    group.push(cell);
    categories.set(category, group);
  }
  // aggregate() splits alpha across metrics; split here across categories and arms,
  // including A/A, to keep the full preregistered interval family conservative.
  const armFamilies = Math.max(
    1,
    ...[...categories.values()].map(
      (group) => 1 + group.filter(inferentialCompetitor).length,
    ),
  );
  const analysisPlan = {
    ...plan,
    alpha: plan.alpha / Math.max(1, categories.size) / armFamilies,
  };
  const summaries = [...categories].map(([category, group]) => {
    const representative =
      group.find((c) => c.library === 'valve') ?? group[0]!;
    const spec: CellSpec = {
      ...representative,
      id: `libs/${category}`,
      library: 'valve',
      notes: [
        ...new Set(group.flatMap((c) => c.notes ?? [])),
        versions,
        'Paired differences are library minus Valve; Valve A/A uses the same build in separate trials. Intervals require at least five pairs and a stable A/A control.',
        `Interval alpha is split across ${categories.size} planned categories, ${armFamilies} arm families (including A/A), three metrics, and ${plan.looks.length} preregistered looks.`,
        'appCpuUsPerGrant is application CPU microseconds per useful callback start. Wait P99 is conditional on starting; inspect outcome counts alongside it.',
        'Identity is an unconstrained harness floor, reported as raw absolutes only; no floor is subtracted.',
        ...(category === 'L4'
          ? [
              'Bottleneck burst-bank mapping is approximate: raw descriptive diagnostics only; no performance superiority or equivalence inference.',
            ]
          : []),
      ],
    };
    const byId = new Map(group.map((c) => [c.id, c]));
    const hash = cellHash(spec);
    const analysisRows = rows.flatMap((row) => {
      const cell = byId.get(row.cellId);
      if (!cell) return [];
      if (row.arm !== 'base' && !(cell.library === 'valve' && row.arm === 'aa'))
        throw new Error(
          `Unexpected library trial arm ${row.arm} in ${row.cellId}`,
        );
      return [
        {
          ...row,
          cellId: spec.id,
          cellHash: hash,
          arm: row.arm === 'aa' ? 'aa' : cell.library,
        },
      ];
    });
    return aggregate(
      analysisRows,
      [spec],
      {
        base: 'valve',
        candidates: group.filter(inferentialCompetitor).map((c) => c.library),
        aa: 'aa',
        plan: analysisPlan,
        metricsFor: libraryMetricsFor,
        isFinalLook: true,
      },
      original,
    );
  });
  const result: RunSummary = {
    ...original,
    decision: plan,
    cells: summaries.flatMap((s) => s.cells),
    safety:
      original.safety === 'FAIL' || summaries.some((s) => s.safety === 'FAIL')
        ? 'FAIL'
        : original.safety === 'UNVERIFIED' ||
            summaries.some((s) => s.safety === 'UNVERIFIED')
          ? 'UNVERIFIED'
          : 'PASS',
  };
  // Restore the across-category Holm family after category-local aggregation.
  const families = new Map<
    string,
    (typeof result.cells)[number]['comparisons']
  >();
  for (const cell of result.cells)
    for (const comparison of cell.comparisons) {
      if (comparison.arm === 'aa' || comparison.permutationP === null) continue;
      const key = `${comparison.arm}|${comparison.metric}`;
      const family = families.get(key) ?? [];
      family.push(comparison);
      families.set(key, family);
    }
  for (const family of families.values()) {
    const adjusted = holm(family.map((c) => c.permutationP!));
    family.forEach((c, i) => {
      c.adjustedP = adjusted[i]!;
    });
  }
  return result;
}

function inferentialCompetitor(cell: CellSpec): boolean {
  return (
    cell.library !== 'valve' &&
    cell.library !== 'identity' &&
    !(libraryCategory(cell) === 'L4' && cell.library === 'bottleneck')
  );
}
