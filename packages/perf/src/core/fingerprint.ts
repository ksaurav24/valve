// Environment fingerprint. Results are only comparable within one fingerprint id.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { objectHash } from './hash.ts';

const read = (path: string) => {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
};
const run = (cmd: string, args: string[]) => {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10000,
    }).trim();
  } catch {
    return null;
  }
};

export interface Fingerprint {
  platform: string;
  arch: string;
  kernel: string;
  cpuModel: string;
  logicalCpus: number;
  /** Distinct max frequencies (MHz) - distinguishes hybrid P/E cores. */
  cpuMaxMHz: number[];
  governor: string | null;
  memTotalGiB: number;
  swapTotalGiB: number | null;
  node: string;
  v8: string;
  docker: string | null;
  cgroupV2: boolean;
  delegatedControllers: string[];
  systemdRun: boolean;
  taskset: boolean;
  /** Server images by infra name → image id digest. */
  servers: Record<string, string>;
  /** Timer lateness profile from `perf doctor` (ms), if measured. */
  timerLateness?: { p50: number; p99: number; max: number };
}

/** Fields that define comparability. Volatile details are kept out of the id. */
export function fingerprintId(fp: Fingerprint): string {
  return objectHash({
    platform: fp.platform,
    kernel: fp.kernel,
    arch: fp.arch,
    cpuModel: fp.cpuModel,
    logicalCpus: fp.logicalCpus,
    cpuMaxMHz: fp.cpuMaxMHz,
    governor: fp.governor,
    memTotalGiB: Math.round(fp.memTotalGiB),
    node: fp.node,
    v8: fp.v8,
    docker: fp.docker,
    servers: fp.servers,
    cgroupV2: fp.cgroupV2,
  });
}

function cpuMaxMHz(): number[] {
  const base = '/sys/devices/system/cpu';
  if (!existsSync(base)) return [];
  const set = new Set<number>();
  for (const d of readdirSync(base).filter((x) => /^cpu\d+$/.test(x))) {
    const v = read(`${base}/${d}/cpufreq/cpuinfo_max_freq`);
    if (v) set.add(Math.round(Number(v) / 1000));
  }
  return [...set].sort((a, b) => a - b);
}

function delegated(): string[] {
  const uid = process.getuid?.();
  const path = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`;
  return read(path)?.split(/\s+/).filter(Boolean) ?? [];
}

/** Capture the fingerprint. `servers` maps infra names to image ids. */
export function captureFingerprint(
  servers: Record<string, string> = {},
): Fingerprint {
  const meminfo = read('/proc/meminfo') ?? '';
  const kb = (key: string) => {
    const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(meminfo);
    return m ? Number(m[1]) : null;
  };
  const swap = kb('SwapTotal');
  return {
    platform: process.platform,
    arch: process.arch,
    kernel: os.release(),
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    logicalCpus: os.cpus().length,
    cpuMaxMHz: cpuMaxMHz(),
    governor: read('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor'),
    memTotalGiB: os.totalmem() / 2 ** 30,
    swapTotalGiB: swap === null ? null : swap / 2 ** 20,
    node: process.version,
    v8: process.versions.v8,
    docker: run('docker', ['version', '--format', '{{.Server.Version}}']),
    cgroupV2: existsSync('/sys/fs/cgroup/cgroup.controllers'),
    delegatedControllers: delegated(),
    systemdRun: run('systemd-run', ['--version']) !== null,
    taskset: run('taskset', ['--version']) !== null,
    servers,
  };
}

/** Whether this host can run authoritative (isolated) trials, with reasons when not. */
export function authoritativeCapability(fp: Fingerprint): {
  ok: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (fp.platform !== 'linux') reasons.push('not Linux');
  if (!fp.cgroupV2) reasons.push('no cgroup v2');
  for (const c of ['memory', 'cpu'])
    if (!fp.delegatedControllers.includes(c))
      reasons.push(`cgroup controller ${c} not delegated to the user`);
  if (!fp.systemdRun) reasons.push('systemd-run unavailable');
  if (!fp.taskset) reasons.push('taskset unavailable');
  if (!fp.docker) reasons.push('docker unavailable');
  return { ok: reasons.length === 0, reasons };
}
