import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { main, parseCli, UsageError } from '../src/cli.ts';
import { preparePlan, runTier } from '../src/tiers/run.ts';
import * as isolation from '../src/supervisor/isolate.ts';
import * as builds from '../src/identity/build.ts';

vi.mock('../src/supervisor/isolate.ts', async (original) => ({
  ...(await original<typeof import('../src/supervisor/isolate.ts')>()),
  decideIsolation: vi.fn(() => ({
    authoritative: false,
    reasons: ['test host lacks isolation'],
  })),
}));

describe('CLI validation and bounded planning', () => {
  it('resolves patch paths from the original pnpm invocation directory', () => {
    vi.stubEnv('INIT_CWD', '/tmp/valve-perf-cli');
    try {
      expect(
        parseCli(['build', '--ref', 'HEAD', '--patch', 'candidate.patch'])
          .options!.patch,
      ).toBe(resolve('/tmp/valve-perf-cli', 'candidate.patch'));
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it.each([
    ['smoke', '--reps', '0'],
    ['matrix', '--workers', '65'],
    ['soak', '--duration', '0s'],
    ['soak', '--duration', '13h'],
    ['plan', '--profile', 'unknown'],
    ['micro', '--window', '1s'],
    ['smoke', '--stores', 'unknown'],
    ['smoke', '--window', '1s', '--duration', '2s'],
    ['matrix', '--head', 'HEAD', '--current'],
    ['report', '--unknown'],
    ['smoke', '--worker-cpus', '3-1'],
    ['smoke', '--run-id', '../escape'],
    ['smoke', '--endpoint', 'http://localhost'],
    ['not-a-command'],
  ])('refuses invalid arguments %j', (...args) => {
    expect(() => parseCli(args)).toThrow(UsageError);
  });

  it('prints help without performing a run', async () => {
    const lines: string[] = [];
    expect(await main(['--help'], (s) => lines.push(s))).toBe(0);
    expect(lines.join('\n')).toContain('--require-authoritative');
  });

  it('applies short sample knobs before estimating and executing', () => {
    const { options } = parseCli([
      'smoke',
      '--suite',
      'gcra',
      '--stores',
      'memory',
      '--window',
      '0.2s',
      '--warmup-ms',
      '0',
      '--drain-ms',
      '20',
      '--reps',
      '2',
      '--workers',
      '1',
    ]);
    const plan = preparePlan(options!);
    expect(plan.cells).toHaveLength(1);
    expect(plan.cells[0]!.timing).toEqual({
      windowMs: 200,
      warmupMs: 0,
      drainMs: 20,
    });
    expect(plan.cells[0]!.workers).toBe(1);
    expect(plan.looks).toEqual([2]);
    expect(plan.armNames).toEqual(['base']);
  });

  it('dry run does not build artifacts or execute trials', async () => {
    const build = vi.spyOn(builds, 'currentBuild');
    try {
      expect(
        await main(
          [
            'matrix',
            '--base',
            'current',
            '--suite',
            'gcra',
            '--stores',
            'redis74',
            '--cell',
            'sat-1w-100-b1',
            '--reps',
            '1',
            '--dry-run',
          ],
          () => undefined,
        ),
      ).toBe(0);
      expect(build).not.toHaveBeenCalled();
    } finally {
      build.mockRestore();
    }
  });

  it('nightly budget reserves setup and truncates by priority', () => {
    const full = preparePlan({
      tier: 'matrix',
      profile: 'targeted',
      suites: ['gcra'],
      stores: ['redis74'],
    });
    const cut = preparePlan({
      tier: 'matrix',
      profile: 'nightly',
      suites: ['gcra'],
      stores: ['redis74'],
      budgetSec: 300,
    });
    expect(cut.estimateSec).toBeLessThanOrEqual(300);
    expect(cut.cells.length).toBeLessThan(full.cells.length);
    expect(cut.skipped.some((x) => x.reason.includes('budget'))).toBe(true);
    expect(cut.cells.every((c) => c.priority === 0)).toBe(true);
  });

  it('refuses an hour-plus run before builds without --yes', async () => {
    await expect(
      runTier(
        { tier: 'soak', suites: ['lease'], windowMs: 7200000 },
        () => undefined,
      ),
    ).rejects.toThrow('--yes');
  });

  it('fails required authority before building or starting trials', async () => {
    const build = vi.spyOn(builds, 'currentBuild');
    try {
      await expect(
        main(
          [
            'smoke',
            '--suite',
            'gcra',
            '--stores',
            'memory',
            '--require-authoritative',
          ],
          () => undefined,
        ),
      ).rejects.toThrow('Authoritative execution required');
      expect(isolation.decideIsolation).toHaveBeenCalled();
      expect(build).not.toHaveBeenCalled();
    } finally {
      build.mockRestore();
    }
  });

  it('keeps soak as continuous low offered load with periodic state samples', () => {
    const plan = preparePlan({
      tier: 'soak',
      suites: ['lease'],
      workers: 4,
      windowMs: 10000,
    });
    expect(plan.cells).toHaveLength(1);
    const cell = plan.cells[0]!;
    expect(cell.workload.arrival).toEqual({ kind: 'poisson', ratePerSec: 2 });
    expect(cell.workload.runtime?.sampleEveryMs).toBe(1000);
    expect(cell.timing.windowMs).toBe(10000);
    expect(cell.faults).toEqual([]);
  });

  it('keeps faults within explicit sample windows', () => {
    const plan = preparePlan({
      tier: 'chaos',
      faults: ['redis-pause'],
      windowMs: 200,
    });
    const cell = plan.cells[0]!;
    expect(cell.faults).toHaveLength(1);
    const fault = cell.faults![0]!;
    expect(fault.atMs).toBeGreaterThanOrEqual(0);
    expect(fault.atMs).toBeLessThan(200);
    if (fault.type === 'redis-pause')
      expect(fault.atMs + fault.ms).toBeLessThan(200);
  });

  it('records unsupported competitor categories as N/A', () => {
    const plan = preparePlan({ tier: 'libs', categories: ['L2'] });
    expect(plan.cells.some((c) => c.library === 'p-limit')).toBe(false);
    expect(
      plan.skipped.some(
        (s) => s.what === 'L2/p-limit' && s.reason.startsWith('N/A'),
      ),
    ).toBe(true);
  });

  it('rejects misspelled suite and category filters', () => {
    expect(() => preparePlan({ tier: 'smoke', suites: ['typo'] })).toThrow();
    expect(() => preparePlan({ tier: 'libs', categories: ['L9'] })).toThrow();
  });
});
