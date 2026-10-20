import { afterEach, describe, expect, it, vi } from 'vitest';
const host = vi.hoisted(() => ({ paths: new Set<string>(), elapsed: false }));
vi.mock('node:fs', () => ({
  existsSync: (p: string) => p === '/proc/meminfo' || host.paths.has(p),
  readFileSync: (p: string) => {
    if (p === '/proc/meminfo') return 'MemAvailable: 8000000 kB';
    if (p === '/proc/vmstat') return 'pswpin 0\npswpout 0\noom_kill 0';
    if (p === '/proc/stat')
      return `cpu ${host.elapsed ? 1100 : 1000} 0 0 0 0 0 0 0`;
    if (p.endsWith('/cpu.stat'))
      return `usage_usec ${host.elapsed ? (p === '/benchmark/cpu.stat' ? 200000 : 500000) : 0}`;
    if (p.endsWith('/memory.events')) return 'oom 0\noom_kill 0';
    if (p.endsWith('/memory')) return 'some total=0\nfull total=0';
    return '0';
  },
}));
import {
  containerScopes,
  DEFAULT_POLICY,
  ResourceMonitor,
} from '../src/supervisor/resources.ts';
afterEach(() => {
  vi.useRealTimers();
  host.paths.clear();
  host.elapsed = false;
});
describe('server CPU accounting', () => {
  it('discovers both Docker cgroup drivers and withholds partial accounting', () => {
    host.paths.add('/sys/fs/cgroup/system.slice/docker-systemd.scope');
    host.paths.add('/sys/fs/cgroup/docker/cgroupfs');
    expect(containerScopes(['systemd', 'cgroupfs'])).toEqual([
      '/sys/fs/cgroup/system.slice/docker-systemd.scope',
      '/sys/fs/cgroup/docker/cgroupfs',
    ]);
    expect(containerScopes(['systemd', 'rootless-unknown'])).toBeNull();
  });
  it.each([false, true])(
    'reports missing scope accounting as unknown (known=%s)',
    (known) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const monitor = new ResourceMonitor(
        DEFAULT_POLICY,
        true,
        known ? ['/server'] : null,
        () => undefined,
        '/benchmark',
      );
      monitor.edge('start');
      host.elapsed = true;
      vi.setSystemTime(1000);
      monitor.edge('end');
      const result = monitor.finish();
      expect(result.benchmarkCores).toBe(0.2);
      expect(result.serverCores).toBe(known ? 0.5 : null);
      if (known) expect(result.backgroundCores).toBeCloseTo(0.3);
      else expect(result.backgroundCores).toBeNull();
      expect(result.reasons).not.toContain('background-cpu');
      expect(result.valid).toBe(known);
    },
  );
});
