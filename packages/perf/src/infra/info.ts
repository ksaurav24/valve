// Redis INFO snapshots at window edges: server CPU and per-command call/µs counters.
import type { Redis } from 'ioredis';
import { epochNow } from '../core/clock.ts';

export interface InfoSnapshot {
  at: number;
  cpuSec: number;
  commands: Record<string, { calls: number; usec: number }>;
  usedMemory: number;
  version: string;
}

/** Capture Redis or Valkey CPU, command counters, memory, and version at a window edge. */
export async function infoSnapshot(client: Redis): Promise<InfoSnapshot> {
  const text = await client.info('all');
  const field = (k: string) => new RegExp(`^${k}:(\\S+)`, 'm').exec(text)?.[1];
  const commands: InfoSnapshot['commands'] = {};
  for (const m of text.matchAll(/^cmdstat_(\S+?):calls=(\d+),usec=(\d+)/gm))
    commands[m[1]!] = { calls: Number(m[2]), usec: Number(m[3]) };
  return {
    at: epochNow(),
    cpuSec:
      Number(field('used_cpu_sys') ?? 0) + Number(field('used_cpu_user') ?? 0),
    commands,
    usedMemory: Number(field('used_memory') ?? 0),
    version: field('valkey_version') ?? field('redis_version') ?? 'unknown',
  };
}

export interface InfoDelta {
  wallSec: number;
  cpuSec: number;
  evalshaCalls: number;
  evalshaUsec: number;
  evalCalls: number;
  /** All command calls except INFO (includes commands executed inside scripts; instrumented arms add one RPUSH per script). */
  commands: number;
  usedMemory: number;
}

// Only the sampler's own commands are excluded; commands run inside scripts are server work.
const HARNESS = new Set(['info']);

/** Compute window counter differences, excluding only the harness's own INFO commands. */
export function infoDelta(a: InfoSnapshot, b: InfoSnapshot): InfoDelta {
  const d = (name: string, k: 'calls' | 'usec') =>
    (b.commands[name]?.[k] ?? 0) - (a.commands[name]?.[k] ?? 0);
  let commands = 0;
  for (const name of Object.keys(b.commands))
    if (!HARNESS.has(name)) commands += d(name, 'calls');
  return {
    wallSec: (b.at - a.at) / 1000,
    cpuSec: b.cpuSec - a.cpuSec,
    evalshaCalls: d('evalsha', 'calls'),
    evalshaUsec: d('evalsha', 'usec'),
    evalCalls: d('eval', 'calls'),
    commands,
    usedMemory: b.usedMemory,
  };
}
