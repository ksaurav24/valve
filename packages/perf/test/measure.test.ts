import { describe, expect, it } from 'vitest';
import { join, relative } from 'node:path';
import { fileSha256 } from '../src/core/hash.ts';
import { currentBuild } from '../src/identity/build.ts';
import {
  bundleFootprint,
  sizeChecks,
  SIZE_BUDGETS,
  type BundleRow,
} from '../src/measure/bundle.ts';
import { startupSample, driftSample } from '../src/measure/process.ts';
import { scopedProbe } from '../src/measure/scoped.ts';

const build = currentBuild({ rebuild: false });

describe('perf-owned artifact measurements', () => {
  it('keeps source measurements on a matching frozen snapshot, including private modules', () => {
    expect(relative(process.cwd(), build.packageDir)).toContain('.perf/');
    expect(build.sourceFiles?.['src/scoped.ts']).toBeDefined();
    for (const [path, hash] of Object.entries(build.sourceFiles!))
      expect(fileSha256(join(build.packageDir, path))).toBe(hash);
  });

  it('records source/dist entries, tree-shaken consumers, and module attribution', async () => {
    const rows = await bundleFootprint(build);
    expect(rows).toHaveLength(20);
    const source = rows.find(
      (r) => r.input === 'src' && r.name === 'entry/core',
    )!;
    expect(source.gzipBytes).toBeGreaterThan(0);
    expect(Object.keys(source.modules)).toContain('src/valve.ts');
    const errors = rows.find(
      (r) => r.input === 'dist' && r.name === 'consumer/errors',
    )!;
    expect(errors.gzipBytes).toBeLessThan(source.gzipBytes);
    const checks = sizeChecks(rows);
    expect(checks).toHaveLength(4);
    expect(checks.every((c) => typeof c.pass === 'boolean')).toBe(true);
  });

  it('fails missing, duplicate, malformed, or excessive size measurements', () => {
    const rows = ['core', 'redis', 'headers', 'group'].map((entry) => ({
      input: 'src',
      name: `entry/${entry}`,
      bytes: 100,
      gzipBytes: 100,
      modules: {},
    })) as BundleRow[];
    expect(sizeChecks(rows).every((c) => c.pass)).toBe(true);
    const legacy = rows.filter((row) => row.name !== 'entry/group');
    expect(sizeChecks(legacy, false)).toHaveLength(3);
    expect(sizeChecks(legacy, false).every((check) => check.pass)).toBe(true);
    expect(
      sizeChecks(legacy).find((check) => check.entry === 'group')?.pass,
    ).toBe(false);
    expect(sizeChecks(rows.slice(1))[0]!.pass).toBe(false);
    expect(sizeChecks([...rows, rows[0]!])[0]!.pass).toBe(false);
    for (const size of [NaN, Infinity, 0, -1, SIZE_BUDGETS.core + 1])
      expect(
        sizeChecks([{ ...rows[0]!, gzipBytes: size }, ...rows.slice(1)])[0]!
          .pass,
      ).toBe(false);
  });

  it.each(['core', 'redis', 'headers'] as const)(
    'cold imports the %s artifact without a store server',
    (entry) => {
      const sample = startupSample(build, entry);
      expect(sample.importMs).toBeGreaterThan(0);
      expect(sample.initMs).toBeGreaterThanOrEqual(0);
      expect(sample.maxRssBytes).toBeGreaterThan(0);
    },
  );

  it('counts all callbacks through the asynchronous public-store drift probe', () => {
    const sample = driftSample(build, 8, 1);
    expect(sample.completed).toBe(8);
    expect(sample.acquisitions).toBeGreaterThan(0);
    expect(sample.elapsedMs).toBeGreaterThan(0);
    expect(sample).not.toHaveProperty('events');
  });

  it('preserves batch-one mixed semantics and checks grants separately from evaluations', async () => {
    const probe = await scopedProbe(build, {
      store: 'memory',
      prefix: 'measure-test',
      iterations: 2,
    });
    expect(probe.results).toHaveLength(27);
    expect(
      probe.results
        .filter((r) => r.batch === 1 && r.workload === 'mixed')
        .every((r) => r.granted === 2),
    ).toBe(true);
    expect(
      probe.results
        .filter((r) => r.workload === 'hot')
        .every((r) => r.granted === 1),
    ).toBe(true);
    expect(
      probe.results.find(
        (r) => r.batch === 128 && r.ruleCount === 16 && r.workload === 'cold',
      )?.logicalKeysPerCall,
    ).toBe(1921);
  });
});
