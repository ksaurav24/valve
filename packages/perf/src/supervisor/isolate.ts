// Authoritative isolation: re-execute the CLI inside a transient systemd user scope with a
// memory cap and no swap, then pin workers with taskset away from the server CPUs. When any
// requirement is missing the run continues as non-authoritative and says why.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  authoritativeCapability,
  type Fingerprint,
} from '../core/fingerprint.ts';
import { cpuList, isolationStatus, DEFAULT_POLICY } from './resources.ts';
import { readInfra } from '../infra/servers.ts';
import { expandCpus } from './resources.ts';

export const ISOLATED_ENV = 'VALVE_PERF_ISOLATED';

/** Re-exec under systemd-run when `--isolate` is requested and we are not already inside. Returns exit code, or null to continue in-process. */
export function reexecIsolated(
  argv: readonly string[],
  memoryMaxGiB = DEFAULT_POLICY.maxGroupGiB + 1,
): number | null {
  if (process.env[ISOLATED_ENV] === '1') return null;
  const args = [
    '--user',
    '--scope',
    '--quiet',
    '--collect',
    '-p',
    `MemoryMax=${memoryMaxGiB}G`,
    '-p',
    `MemoryHigh=${(memoryMaxGiB - 0.5).toFixed(1)}G`,
    '-p',
    'MemorySwapMax=0',
    process.execPath,
    ...process.execArgv,
    ...argv,
  ];
  const r = spawnSync('systemd-run', args, {
    stdio: 'inherit',
    env: { ...process.env, [ISOLATED_ENV]: '1' },
  });
  if (r.error) {
    console.error(
      `isolation unavailable (${String(r.error)}); continuing non-authoritatively`,
    );
    return null;
  }
  return r.status ?? 1;
}

export interface IsolationDecision {
  authoritative: boolean;
  reasons: string[];
  workerCpus?: string;
  serverCpus?: Record<string, string>;
}

/** Decide authority for this run: capability, protected cgroup, pinned servers, direct addresses. */
export function decideIsolation(
  fp: Fingerprint,
  servers: readonly string[],
  requested: boolean,
  workerCpus?: string,
): IsolationDecision {
  const reasons: string[] = [];
  if (!requested) reasons.push('isolation not requested (--isolate)');
  const cap = authoritativeCapability(fp);
  reasons.push(...cap.reasons);
  const iso = isolationStatus();
  if (requested && !iso.protected)
    reasons.push(`process not in a protected cgroup (${iso.detail})`);
  const infra = readInfra().servers;
  const pinned: number[] = [];
  const serverCpus: Record<string, string> = {};
  for (const name of servers) {
    const s = infra[name];
    if (!s) {
      reasons.push(`server ${name} is not registered`);
      continue;
    }
    let liveCpus: string | undefined;
    if (s.container) {
      try {
        liveCpus = execFileSync(
          'docker',
          ['inspect', '-f', '{{.HostConfig.CpusetCpus}}', s.container],
          { encoding: 'utf8' },
        ).trim();
      } catch {
        reasons.push(`server ${name} live CPU pinning unavailable`);
      }
    }
    if (!liveCpus)
      reasons.push(
        `server ${name} not CPU-pinned (pnpm perf infra up ${name} --cpuset …)`,
      );
    else {
      pinned.push(...expandCpus(liveCpus));
      serverCpus[name] = liveCpus;
    }
    if (process.env.VALVE_PERF_HOST_PORTS === '1')
      reasons.push('loopback ports via docker-proxy (VALVE_PERF_HOST_PORTS=1)');
  }
  let cpus = workerCpus;
  const reserved = pinned.flatMap((cpu) => {
    try {
      return expandCpus(
        readFileSync(
          `/sys/devices/system/cpu/cpu${cpu}/topology/thread_siblings_list`,
          'utf8',
        ).trim(),
      );
    } catch {
      return [cpu];
    }
  });
  if (!cpus && pinned.length) {
    const free = cpuList().filter((c) => !reserved.includes(c));
    if (free.length) cpus = free.join(',');
  }
  if (!cpus) reasons.push('workers not CPU-pinned');
  if (cpus) {
    const chosen = expandCpus(cpus);
    const allowed = cpuList();
    if (chosen.some((c) => !allowed.includes(c)))
      reasons.push('worker CPUs outside process affinity');
    if (chosen.some((c) => pinned.includes(c)))
      reasons.push('worker CPUs overlap server CPUs');
    else if (chosen.some((c) => reserved.includes(c)))
      reasons.push('worker CPUs share a physical core with a server CPU');
  }
  return {
    authoritative: reasons.length === 0,
    reasons,
    serverCpus,
    ...(cpus ? { workerCpus: cpus } : {}),
  };
}
