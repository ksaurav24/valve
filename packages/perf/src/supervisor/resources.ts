// Resource admission and contamination telemetry, ported from slotExp `resources.mjs` (policy v5,
// itself derived from round-4 policy v4). Behavior is unchanged; thresholds are configurable and
// recorded in every manifest. On hosts without cgroup v2 / Linux procfs the monitor degrades to
// annotations only and trials are marked non-authoritative.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cpus } from 'node:os';

export interface ResourcePolicy {
  version: string;
  sampleMs: number;
  minStartAvailableGiB: number;
  minRunningAvailableGiB: number;
  maxGroupGiB: number;
  maxSomeStallFraction: number;
  maxFullStallFraction: number;
  maxSwapInPages: number;
  maxSwapOutPages: number;
  maxBackgroundCores: number;
  quietMs: number;
  maxQuietWaitMs: number;
}

export const DEFAULT_POLICY: ResourcePolicy = {
  version: 'v5-ts1',
  sampleMs: 100,
  minStartAvailableGiB: 3,
  minRunningAvailableGiB: 1.5,
  maxGroupGiB: 5,
  maxSomeStallFraction: 0.001,
  maxFullStallFraction: 0.0005,
  maxSwapInPages: 256,
  maxSwapOutPages: 0,
  maxBackgroundCores: 1.5,
  quietMs: 2000,
  maxQuietWaitMs: 120000,
};

const GiB = 1024 ** 3;
const linux = process.platform === 'linux' && existsSync('/proc/meminfo');

const read = (p: string) => readFileSync(p, 'utf8');
const keyed = (path: string) =>
  Object.fromEntries(
    read(path)
      .trim()
      .split('\n')
      .map((s) => s.trim().split(/\s+/))
      .map(([k, v]) => [k!.replace(':', ''), Number(v)]),
  ) as Record<string, number>;
function psi(path: string): { some: number; full: number } {
  const v = { some: 0, full: 0 };
  try {
    for (const line of read(path).trim().split('\n')) {
      const [kind, ...rest] = line.split(' ');
      const total = rest.find((s) => s.startsWith('total='));
      if (total && (kind === 'some' || kind === 'full'))
        v[kind] = Number(total.slice(6));
    }
  } catch {
    // PSI unavailable
  }
  return v;
}

/** cgroup v2 directory of this process, or null. */
export function ownCgroup(): string | null {
  if (!linux) return null;
  try {
    const line = read('/proc/self/cgroup')
      .trim()
      .split('\n')
      .find((s) => s.startsWith('0::'));
    return line ? join('/sys/fs/cgroup', line.slice(3)) : null;
  } catch {
    return null;
  }
}

function cgNum(cg: string | null, f: string): number {
  if (!cg) return NaN;
  try {
    const v = read(join(cg, f)).trim();
    return v === 'max' ? Infinity : Number(v);
  } catch {
    return NaN;
  }
}
function cgCpuUs(dir: string | null): number {
  if (!dir) return NaN;
  try {
    const line = read(join(dir, 'cpu.stat'))
      .split('\n')
      .find((l) => l.startsWith('usage_usec'));
    return Number(line?.split(' ')[1]);
  } catch {
    return NaN;
  }
}

interface Snapshot {
  at: number;
  available: number;
  swapIn: number;
  swapOut: number;
  oomKills: number;
  psi: { some: number; full: number };
  group: number;
  groupSwap: number;
  events: Record<string, number>;
  busyJiffies: number;
  groupCpuUs: number;
  serverCpuUs: number;
}

/** Docker scope dirs of server containers (their CPU is accounted as "server", not background). */
export function containerScopes(containerIds: readonly string[]): string[] {
  return containerIds
    .map((id) => `/sys/fs/cgroup/system.slice/docker-${id}.scope`)
    .filter((p) => existsSync(p));
}

function snapshot(cg: string | null, scopes: readonly string[]): Snapshot {
  if (!linux)
    return {
      at: Date.now(),
      available: NaN,
      swapIn: 0,
      swapOut: 0,
      oomKills: 0,
      psi: { some: 0, full: 0 },
      group: NaN,
      groupSwap: 0,
      events: {},
      busyJiffies: NaN,
      groupCpuUs: NaN,
      serverCpuUs: NaN,
    };
  const m = keyed('/proc/meminfo');
  const vm = keyed('/proc/vmstat');
  const cpu = read('/proc/stat')
    .split('\n')[0]!
    .trim()
    .split(/\s+/)
    .slice(1)
    .map(Number);
  const total = cpu.reduce((a, b) => a + b, 0);
  let events: Record<string, number> = {};
  try {
    if (cg) events = keyed(join(cg, 'memory.events'));
  } catch {
    // no memory controller
  }
  return {
    at: Date.now(),
    available: (m.MemAvailable ?? NaN) * 1024,
    swapIn: vm.pswpin ?? 0,
    swapOut: vm.pswpout ?? 0,
    oomKills: vm.oom_kill ?? 0,
    psi: psi('/proc/pressure/memory'),
    group: cgNum(cg, 'memory.current'),
    groupSwap: cgNum(cg, 'memory.swap.current') || 0,
    events,
    busyJiffies: total - (cpu[3] ?? 0) - (cpu[4] ?? 0),
    groupCpuUs: cgCpuUs(cg),
    serverCpuUs: scopes.reduce((a, d) => a + cgCpuUs(d), 0),
  };
}

/** Whether this process runs inside a protected cgroup (memory limit, no swap). */
export function isolationStatus(policy = DEFAULT_POLICY): {
  protected: boolean;
  detail: string;
} {
  const cg = ownCgroup();
  if (!cg) return { protected: false, detail: 'no cgroup v2' };
  const max = cgNum(cg, 'memory.max');
  const swap = cgNum(cg, 'memory.swap.max');
  const ok =
    Number.isFinite(max) && max <= (policy.maxGroupGiB + 1) * GiB && swap === 0;
  return {
    protected: ok,
    detail: `cgroup=${cg} memory.max=${max} swap.max=${swap}`,
  };
}

/** Wait until the host is quiet (headroom, no swap, low PSI) for `quietMs`. */
export async function awaitHeadroom(
  policy = DEFAULT_POLICY,
): Promise<{ availableGiB: number; waitedMs: number; quiet: boolean }> {
  const begin = Date.now();
  if (!linux) return { availableGiB: NaN, waitedMs: 0, quiet: true };
  let first = snapshot(null, []);
  let since = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 250));
    const s = snapshot(null, []);
    const elapsedUs = Math.max(1, s.at - first.at) * 1000;
    const quiet =
      s.available >= policy.minStartAvailableGiB * GiB &&
      s.psi.some - first.psi.some <= elapsedUs * policy.maxSomeStallFraction &&
      s.psi.full - first.psi.full <= elapsedUs * policy.maxFullStallFraction &&
      s.swapOut === first.swapOut &&
      s.swapIn - first.swapIn <= policy.maxSwapInPages &&
      s.oomKills === first.oomKills;
    if (!quiet) {
      first = s;
      since = Date.now();
    }
    if (quiet && Date.now() - since >= policy.quietMs)
      return {
        availableGiB: s.available / GiB,
        waitedMs: Date.now() - begin,
        quiet: true,
      };
    if (Date.now() - begin > policy.maxQuietWaitMs)
      return {
        availableGiB: s.available / GiB,
        waitedMs: Date.now() - begin,
        quiet: false,
      };
  }
}

export interface ResourceSummary {
  valid: boolean;
  authoritative: boolean;
  reasons: string[];
  policyVersion: string;
  swapInPages: number;
  swapOutPages: number;
  someStallUs: number;
  fullStallUs: number;
  minHostAvailableGiB: number | null;
  maxGroupGiB: number | null;
  backgroundCores: number | null;
  benchmarkCores: number | null;
  serverCores: number | null;
  maxSampleGapMs: number;
  samples: number;
}

/** Samples host/cgroup counters during a trial; aborts via callback when guards trip. */
export class ResourceMonitor {
  private samples: Snapshot[] = [];
  private timer: NodeJS.Timeout | undefined;
  private edges: Record<string, Snapshot> = {};
  private windowEdges: [number, number] | null = null;
  aborted: string[] = [];

  constructor(
    private policy: ResourcePolicy,
    private authoritative: boolean,
    private serverScopes: readonly string[],
    private onAbort: (reasons: string[]) => void,
    private cg = ownCgroup(),
  ) {
    this.samples.push(snapshot(this.cg, this.serverScopes));
    if (linux) this.timer = setInterval(() => this.tick(), policy.sampleMs);
  }

  private tick() {
    const s = snapshot(this.cg, this.serverScopes);
    this.samples.push(s);
    const start = this.samples[0]!;
    const reasons: string[] = [];
    if (s.available < this.policy.minRunningAvailableGiB * GiB)
      reasons.push('host-headroom-low');
    if (this.authoritative && s.group > this.policy.maxGroupGiB * GiB)
      reasons.push('benchmark-group-exceeds-limit');
    if (s.oomKills > start.oomKills) reasons.push('host-oom');
    for (const k of ['oom', 'oom_kill'])
      if ((s.events[k] ?? 0) > (start.events[k] ?? 0))
        reasons.push(`cgroup-${k}`);
    if (reasons.length && !this.aborted.length) {
      this.aborted = reasons;
      this.onAbort(reasons);
    }
  }

  /** Exact snapshots at the measured window edges (CPU accounting, PSI and swap windows). */
  edge(name: 'start' | 'end') {
    this.edges[name] = snapshot(this.cg, this.serverScopes);
    if (name === 'end' && this.edges.start)
      this.windowEdges = [this.edges.start.at - 500, this.edges.end!.at];
  }

  finish(): ResourceSummary {
    if (this.timer) clearInterval(this.timer);
    this.tick();
    const reasons = [...this.aborted];
    const [wa, wb] = this.windowEdges ?? [
      this.samples[0]!.at,
      this.samples.at(-1)!.at,
    ];
    let some = 0;
    let full = 0;
    let swapIn = 0;
    let swapOut = 0;
    for (let i = 1; i < this.samples.length; i++) {
      const a = this.samples[i - 1]!;
      const b = this.samples[i]!;
      if (b.at < wa || a.at > wb) continue;
      some += b.psi.some - a.psi.some;
      full += b.psi.full - a.psi.full;
      swapIn += b.swapIn - a.swapIn;
      swapOut += b.swapOut - a.swapOut;
    }
    const windowUs = Math.max(1, (wb - wa) * 1000);
    if (linux) {
      if (some > windowUs * this.policy.maxSomeStallFraction)
        reasons.push('host-memory-some-stalls');
      if (full > windowUs * this.policy.maxFullStallFraction)
        reasons.push('host-memory-full-stalls');
      if (swapIn > this.policy.maxSwapInPages) reasons.push('host-swap-in');
      if (swapOut > this.policy.maxSwapOutPages) reasons.push('host-swap-out');
      if (this.samples.some((s) => s.groupSwap > 0))
        reasons.push('benchmark-swap');
    }
    let background: number | null = null;
    let bench: number | null = null;
    let server: number | null = null;
    const A = this.edges.start;
    const B = this.edges.end;
    if (A && B && linux) {
      const wallUs = Math.max(1, (B.at - A.at) * 1000);
      const jiffyUs = 1e6 / 100;
      const totalUs = (B.busyJiffies - A.busyJiffies) * jiffyUs;
      const groupUs = B.groupCpuUs - A.groupCpuUs;
      const serverUs = B.serverCpuUs - A.serverCpuUs;
      bench = Number.isFinite(groupUs) ? groupUs / wallUs : null;
      server = Number.isFinite(serverUs) ? serverUs / wallUs : null;
      background =
        Math.max(
          0,
          totalUs -
            (Number.isFinite(groupUs) ? groupUs : 0) -
            (Number.isFinite(serverUs) ? serverUs : 0),
        ) / wallUs;
      if (background > this.policy.maxBackgroundCores)
        reasons.push('background-cpu');
    }
    const gaps = this.samples
      .slice(1)
      .map((s, i) => s.at - this.samples[i]!.at);
    const avail = this.samples.map((s) => s.available).filter(Number.isFinite);
    const groups = this.samples.map((s) => s.group).filter(Number.isFinite);
    return {
      // Portable (non-authoritative) runs annotate reasons but never reject.
      valid: !this.authoritative || reasons.length === 0,
      authoritative: this.authoritative,
      reasons,
      policyVersion: this.policy.version,
      swapInPages: swapIn,
      swapOutPages: swapOut,
      someStallUs: some,
      fullStallUs: full,
      minHostAvailableGiB: avail.length
        ? avail.reduce((a, b) => Math.min(a, b), Infinity) / GiB
        : null,
      maxGroupGiB: groups.length
        ? groups.reduce((a, b) => Math.max(a, b), 0) / GiB
        : null,
      backgroundCores: background,
      benchmarkCores: bench,
      serverCores: server,
      maxSampleGapMs: gaps.reduce((a, b) => Math.max(a, b), 0),
      samples: this.samples.length,
    };
  }
}

/** CPU ids available to this process (for worker pinning), from /proc or os.cpus(). */
export function cpuList(): number[] {
  if (linux)
    try {
      const status = read('/proc/self/status');
      const m = /Cpus_allowed_list:\s*(\S+)/.exec(status);
      if (m) return expandCpus(m[1]!);
    } catch {
      // fall through
    }
  return cpus().map((_, i) => i);
}

export function expandCpus(list: string): number[] {
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(list))
    throw new Error(`invalid CPU list: ${list}`);
  const out: number[] = [];
  for (const part of list.split(',')) {
    const [a, b] = part.split('-').map(Number);
    if (b === undefined) out.push(a!);
    else {
      if (b < a! || b - a! > 65536)
        throw new Error(`invalid CPU range: ${part}`);
      for (let i = a!; i <= b; i++) out.push(i);
    }
  }
  return out;
}
