/** Tests for the read-only legacy evidence catalog and slotexp projection. */

import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { mean, sd, pairedT } from '../src/analyze/stats.ts';
import { describe, expect, it } from 'vitest';
import { catalogArchive } from '../src/legacy/catalog.ts';
import { readSlotexpRows } from '../src/legacy/slotexp.ts';

const archiveDir = process.env.VALVE_EVIDENCE_ARCHIVE;
const fixture = resolve('test/fixtures/legacy/confirm-subset.jsonl');

describe('legacy evidence', () => {
  it.skipIf(!archiveDir || !existsSync(archiveDir))(
    'catalogs the preserved archive manifest',
    async () => {
      const catalog = await catalogArchive(archiveDir!);
      expect(catalog.files).toBe(6_906);
      expect(catalog.families).toEqual({
        baseline: 54,
        'drift-results': 11,
        'footprint-results': 29,
        'scoped-results': 6,
        'slotexp-validation': 4_600,
        'thundering-herd': 2_181,
        'top-level': 25,
      });
      expect(catalog.sourceCommit).toBe(
        '197902098769e5abf396d16582a42d1b7a123ded',
      );
    },
  );

  it('projects the first three confirm cells', async () => {
    const rows = readSlotexpRows(await readFile(fixture, 'utf8'));
    expect(new Set(rows.map((row) => row.cell)).size).toBe(3);
    expect(new Set(rows.map((row) => row.arm))).toEqual(
      new Set(['prod', 'aa', 'cand']),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.stage === 'confirm')).toBe(true);
    expect(rows.every((row) => Number.isFinite(row.metrics.utilization))).toBe(
      true,
    );
    expect(rows.every((row) => typeof row.valid === 'boolean')).toBe(true);
  });

  it('records fixture provenance from the archive manifest', async () => {
    const provenance = await readFile(
      resolve('test/fixtures/legacy/PROVENANCE.md'),
      'utf8',
    );
    expect(provenance).toContain(
      '95b90878927a60a270ef00da2bccfc75f0732d56276bba3e32e327bd0505e8e4',
    );
    expect(provenance).toContain('bench/slotexp-validation/raw/confirm.jsonl');
  });
});

it('catalogs portable metadata fixtures without requiring the private evidence archive', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'valve-catalog-'));
  try {
    await writeFile(join(dir, 'README.md'), 'Valve benchmark evidence archive');
    await writeFile(join(dir, 'source-commit.txt'), 'fixture-commit');
    await writeFile(
      join(dir, 'bench-files.sha256'),
      'abc  bench/slotexp-validation/raw/sample.jsonl\ndef  bench/report.md\n',
    );
    const catalog = await catalogArchive(dir);
    expect(catalog.files).toBe(2);
    expect(catalog.families['slotexp-validation']).toBe(1);
    expect(catalog.families['top-level']).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('reproduces archived Python arm means and paired differences on three real legacy cells', async () => {
  const rows = readSlotexpRows(await readFile(fixture, 'utf8'));
  const analysis = JSON.parse(
    await readFile(
      resolve('test/fixtures/legacy/confirm-analysis.json'),
      'utf8',
    ),
  ) as {
    cells: Record<
      string,
      {
        cell: string;
        windows: Record<
          string,
          Record<
            string,
            {
              arms: Record<string, { mean: number; n: number }>;
              aa_vs_prod: { mean: number; sd: number; lo: number; hi: number };
              cand_vs_prod: {
                mean: number;
                sd: number;
                lo: number;
                hi: number;
              };
            }
          >
        >;
      }
    >;
  };
  for (const cell of Object.values(analysis.cells)) {
    const metrics = Object.values(cell.windows)[0]!;
    for (const metric of ['utilization', 'callsPerGrant', 'jain'] as const) {
      for (const arm of ['prod', 'aa', 'cand']) {
        const selected = rows
          .filter((r) => r.cell === cell.cell && r.arm === arm && r.valid)
          .map((r) => r.metrics[metric]!);
        expect(selected.length).toBe(metrics[metric]!.arms[arm]!.n);
        expect(mean(selected)).toBeCloseTo(
          metrics[metric]!.arms[arm]!.mean,
          10,
        );
      }
      const baseline = new Map(
        rows
          .filter((r) => r.cell === cell.cell && r.arm === 'prod' && r.valid)
          .map((r) => [r.rep, r]),
      );
      for (const arm of ['aa', 'cand'] as const) {
        const differences = rows
          .filter(
            (r) =>
              r.cell === cell.cell &&
              r.arm === arm &&
              r.valid &&
              baseline.has(r.rep),
          )
          .map(
            (r) => r.metrics[metric]! - baseline.get(r.rep)!.metrics[metric]!,
          );
        const reference =
          metrics[metric]![arm === 'aa' ? 'aa_vs_prod' : 'cand_vs_prod'];
        expect(mean(differences)).toBeCloseTo(reference.mean, 10);
        expect(sd(differences)).toBeCloseTo(reference.sd, 10);
        const interval = pairedT(differences, 0.05);
        // Legacy Python used a rounded critical value. Modern inference is independently
        // checked against SciPy in stats.test.ts, not forced to copy that approximation.
        expect(Math.abs(interval.lo! - reference.lo)).toBeLessThan(
          sd(differences) * 0.001 + 1e-10,
        );
        expect(Math.abs(interval.hi! - reference.hi)).toBeLessThan(
          sd(differences) * 0.001 + 1e-10,
        );
      }
    }
  }
});
