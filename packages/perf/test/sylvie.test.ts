import { beforeEach, describe, expect, it, vi } from 'vitest';
import { main, parseCli } from '../src/cli.ts';
import { preparePlan } from '../src/tiers/run.ts';
import { runSylvie } from '../src/tiers/sylvie.ts';
import { selectSylvieCpus } from '../src/supervisor/isolate.ts';
import { SYLVIE_POLICY } from '../src/supervisor/resources.ts';
import * as servers from '../src/infra/servers.ts';
import * as runs from '../src/tiers/run.ts';
import * as builds from '../src/identity/build.ts';

vi.mock('../src/infra/servers.ts', async (original) => ({
  ...(await original<typeof import('../src/infra/servers.ts')>()),
  readInfra: vi.fn(() => ({ version: 1, servers: {} })),
  up: vi.fn(),
  down: vi.fn(),
}));
vi.mock('../src/supervisor/isolate.ts', async (original) => ({
  ...(await original<typeof import('../src/supervisor/isolate.ts')>()),
  sylvieCpus: vi.fn(() => ({ serverCpus: '6', workerCpus: '2,4' })),
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFileSync: vi.fn(() => ''),
}));

beforeEach(() => vi.clearAllMocks());

describe('sylvie preset', () => {
  it('reserves three distinct fast physical cores without using SMT siblings or efficiency cores', () => {
    const topology = Array.from({ length: 12 }, (_, cpu) => ({
      cpu,
      core: `0:${cpu < 8 ? Math.floor(cpu / 2) : cpu - 4}`,
      maxMHz: cpu < 8 ? 4400 : 3300,
    }));
    expect(selectSylvieCpus(topology)).toEqual({
      serverCpus: '6',
      workerCpus: '2,4',
    });
    expect(selectSylvieCpus(topology.filter((c) => c.cpu >= 2))).toEqual({
      serverCpus: '6',
      workerCpus: '2,4',
    });
    expect(() => selectSylvieCpus(topology.filter((c) => c.cpu >= 4))).toThrow(
      'three available physical cores',
    );
    expect(() => selectSylvieCpus([])).toThrow();
  });

  it('plans two bounded workloads, ten pairs, audits and unchanged metric margins', () => {
    const { options } = parseCli(['matrix', '--profile', 'sylvie']);
    expect(options).toMatchObject({
      isolate: true,
      requireAuthoritative: true,
    });
    const plan = preparePlan(options!);
    expect(plan.cells.map((c) => c.id)).toEqual([
      'sylvie/gcra-2w',
      'sylvie/lease-2w',
    ]);
    expect(
      plan.cells.every(
        (c) =>
          c.workers === 2 &&
          c.timing.windowMs === 15000 &&
          c.timing.warmupMs === 2000,
      ),
    ).toBe(true);
    expect(plan.looks).toEqual([10]);
    expect(plan.armNames).toEqual(['base', 'aa', 'head']);
    expect(plan.audit).toBe(true);
    expect(
      plan.decision.metrics.find((m) => m.metric === 'capacityUtilization')
        ?.margin,
    ).toBe(0.01);
    expect(plan.estimateSec).toBeLessThan(30 * 60);
    expect(SYLVIE_POLICY.maxGroupGiB).toBe(2);
    expect(SYLVIE_POLICY.minStartAvailableGiB).toBe(4);
    expect(() =>
      preparePlan({ tier: 'matrix', profile: 'sylvie', workers: 4 }),
    ).toThrow('at most two');
    expect(() =>
      preparePlan({ tier: 'matrix', profile: 'sylvie', suites: ['weighted'] }),
    ).toThrow('covers gcra and lease');
    expect(() => parseCli(['smoke', '--profile', 'sylvie'])).toThrow();
  });

  it('dry planning does not build, provision, or require a running store', async () => {
    const build = vi.spyOn(builds, 'currentBuild');
    try {
      const lines: string[] = [];
      expect(
        await main(['plan', '--profile', 'sylvie'], (line) => lines.push(line)),
      ).toBe(0);
      expect(lines.join('\n')).toContain('server 6; workers 2,4');
      expect(build).not.toHaveBeenCalled();
      expect(servers.up).not.toHaveBeenCalled();
      expect(servers.down).not.toHaveBeenCalled();
    } finally {
      build.mockRestore();
    }
  });

  it('cleans up a store it created even when execution fails, and preserves reused stores', async () => {
    const state: servers.InfraState = { version: 1, servers: {} };
    const store: servers.ServerState = {
      container: 'valve-perf-redis74',
      image: 'redis:7.4',
      url: 'redis://127.0.0.1:16479',
      hostUrl: 'redis://127.0.0.1:16479',
      token: 'test',
      createdAt: '',
      cpuset: '6',
      netem: false,
    };
    vi.mocked(servers.readInfra).mockImplementation(() => state);
    vi.mocked(servers.up).mockImplementation(async () => {
      state.servers.redis74 = store;
      return store;
    });
    const run = vi
      .spyOn(runs, 'runTier')
      .mockRejectedValue(new Error('injected execution failure'));
    try {
      await expect(
        runSylvie({ tier: 'matrix' }, () => undefined),
      ).rejects.toThrow('injected execution failure');
      expect(servers.up).toHaveBeenCalledWith('redis74', { cpuset: '6' });
      expect(servers.down).toHaveBeenCalledWith('redis74');
      vi.mocked(servers.down).mockClear();
      run.mockResolvedValue(0);
      expect(await runSylvie({ tier: 'matrix' }, () => undefined)).toBe(0);
      expect(servers.down).not.toHaveBeenCalled();
      expect(run).toHaveBeenLastCalledWith(
        expect.objectContaining({
          base: 'HEAD',
          workerCpus: '2,4',
          isolate: true,
          requireAuthoritative: true,
        }),
        expect.any(Function),
      );
      state.servers.redis74 = { ...store, cpuset: '0' };
      await expect(
        runSylvie({ tier: 'matrix' }, () => undefined),
      ).rejects.toThrow('pinned to CPU 6');
      expect(servers.down).not.toHaveBeenCalled();
    } finally {
      run.mockRestore();
      vi.mocked(servers.readInfra).mockReturnValue({ version: 1, servers: {} });
    }
  });
});
