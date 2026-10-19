import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const fixtures = vi.hoisted(() => ({
  exists: false,
  failure: 'sentinel',
  commands: [] as string[][],
}));
vi.mock('node:child_process', () => ({
  execFileSync: (_command: string, args: string[]) => {
    fixtures.commands.push(args);
    if (args[0] === 'ps')
      return args.includes('-aq')
        ? 'created-container-id'
        : fixtures.exists
          ? 'valve-perf-redis74'
          : '';
    if (args[0] === 'port') return '127.0.0.1:16479';
    if (args[0] === 'inspect') {
      if (args[2]!.includes('Labels')) return '1';
      if (args[2]!.includes('IPAddress')) return '127.0.0.1';
      if (args[2]!.includes('Config.Image')) return 'redis:7.4';
      return '';
    }
    return 'created-container-id';
  },
}));
vi.mock('ioredis', () => ({
  Redis: class {
    async connect() {
      if (fixtures.failure === 'readiness') throw new Error('unreachable');
    }
    async ping() {
      return 'PONG';
    }
    async set() {
      throw new Error('injected sentinel failure');
    }
    disconnect() {}
  },
}));
vi.mock('../src/core/paths.ts', async (original) => ({
  ...(await original<typeof import('../src/core/paths.ts')>()),
  infraFile: '/nonexistent-valve-fixture/infra.json',
}));
import { up } from '../src/infra/servers.ts';
beforeEach(() => {
  fixtures.exists = false;
  fixtures.failure = 'sentinel';
  fixtures.commands.length = 0;
});
afterEach(() => vi.useRealTimers());
describe('transactional store provisioning', () => {
  it('removes only this creation attempt when sentinel registration fails', async () => {
    await expect(up('redis74')).rejects.toThrow('injected sentinel failure');
    const run = fixtures.commands.find((a) => a[0] === 'run')!;
    const creation = run.find((a) => a.startsWith('dev.valve.perf.creation='))!;
    expect(creation).toMatch(/=[0-9a-f-]{36}$/);
    expect(fixtures.commands).toContainEqual([
      'ps',
      '-aq',
      '--filter',
      `label=${creation}`,
    ]);
    expect(fixtures.commands).toContainEqual([
      'rm',
      '-f',
      'created-container-id',
    ]);
  });
  it('does not remove a reused container when setup fails', async () => {
    fixtures.exists = true;
    await expect(up('redis74')).rejects.toThrow('injected sentinel failure');
    expect(fixtures.commands.some((a) => a[0] === 'rm')).toBe(false);
  });
  it('rolls back a readiness timeout before any registry entry exists', async () => {
    vi.useFakeTimers();
    fixtures.failure = 'readiness';
    const result = expect(up('redis74')).rejects.toThrow('not ready');
    await vi.runAllTimersAsync();
    await result;
    expect(fixtures.commands).toContainEqual([
      'rm',
      '-f',
      'created-container-id',
    ]);
  });
});
