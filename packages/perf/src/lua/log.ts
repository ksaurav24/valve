// Decode instrumented-script log entries (`{s,t,k,a,r}` JSON) into typed server events.
// Argument layouts mirror packages/valve/src/redis/index.ts (acquire/scoped/release/renew).
import type { ServerEvent } from '../core/types.ts';

interface Raw {
  s: string;
  t: string;
  k: unknown;
  a: unknown;
  r: unknown;
}

/** cjson encodes empty Lua tables as `{}`; treat any non-array as empty. */
const arr = <T = unknown>(v: unknown): T[] =>
  Array.isArray(v) ? (v as T[]) : [];
const idOf = (key: string) => /\{([^}]*)\}/.exec(key)?.[1] ?? '';
/** Redis TIME "sec.usec" → fractional epoch milliseconds. */
export const timeMs = (t: string) => {
  const [sec, usec] = t.split('.');
  return Number(sec) * 1000 + Number(usec ?? 0) / 1000;
};

/** Decode one log line. Returns null for calls that did not decide admission (config mismatch). */
export function decodeEvent(line: string): ServerEvent | null {
  const e = JSON.parse(line) as Raw;
  const keys = arr<string>(e.k);
  const args = arr<string>(e.a).map(String);
  const t = timeMs(e.t);
  switch (e.s) {
    case 'ACQUIRE': {
      if (!Array.isArray(e.r)) return null;
      const r = e.r as unknown[];
      const leased = args[1] === 'leases';
      let idx = leased ? 5 : 1;
      const nr = keys.length - 2 - (leased ? 1 : 0);
      const rules: Extract<ServerEvent, { op: 'acquire' }>['rules'] = [];
      for (let i = 0; i < nr; i++) {
        rules.push({
          algorithm: args[idx] === '0' ? 'gcra' : 'fixed-window',
          intervalMs: Number(args[idx + 1]),
          limit: Number(args[idx + 2]),
          burst: Number(args[idx + 3]),
        });
        idx += 4;
      }
      const nc = Number(args[idx]);
      const costs = args.slice(idx + 1, idx + 1 + nc).map(Number);
      const event: Extract<ServerEvent, { op: 'acquire' }> = {
        op: 'acquire',
        t,
        id: idOf(keys[0] ?? ''),
        ruleKeys: keys.slice(1, 1 + nr),
        rules,
        costs,
        granted: Number(r[0]),
        retryAfterMs: Number(r[1]),
        pausedMs: Number(r[2]),
      };
      if (leased)
        event.lease = {
          limit: Number(args[2]),
          ttlMs: Number(args[3]),
          owner: args[4]!,
          tokens: arr<string>(r[3]).map(String),
          blocked: Number(r[4] ?? 0) === 1,
        };
      return event;
    }
    case 'SCOPED': {
      if (!Array.isArray(e.r)) return null;
      const r = e.r as unknown[];
      const p = JSON.parse(args[0] ?? '{}') as {
        rules: {
          algorithm: 'gcra' | 'fixed-window';
          intervalMs: number;
          limit: number;
          burst: number;
        }[];
        jobs: { cost: number; refs: number[] }[];
        lease?: { limit: number; ttlMs: number; owner: string };
      };
      const event: Extract<ServerEvent, { op: 'scoped' }> = {
        op: 'scoped',
        t,
        id: idOf(keys[0] ?? ''),
        ruleKeys: keys.slice(3),
        rules: p.rules.map((x) => ({
          algorithm: x.algorithm,
          intervalMs: x.intervalMs,
          limit: x.limit,
          burst: x.burst,
        })),
        jobs: p.jobs,
        grantedIndexes: arr<number>(r[0]).map(Number),
        blocked: arr<unknown[]>(r[1]).map((b) => ({
          index: Number(b[0]),
          retryAfterMs: Number(b[1]),
          ...(b.length > 2 ? { leaseBlocked: Number(b[2]) === 1 } : {}),
        })),
        pausedMs: Number(r[3] ?? 0),
      };
      if (p.lease)
        event.lease = {
          ...p.lease,
          tokens: arr<unknown[]>(r[2]).map((x) => ({
            index: Number(x[0]),
            token: String(x[1]),
          })),
        };
      return event;
    }
    case 'RELEASE':
      return { op: 'release', t, leaseKey: keys[0] ?? '', tokens: args };
    case 'RENEW':
      return {
        op: 'renew',
        t,
        leaseKey: keys[0] ?? '',
        ttlMs: Number(args[0]),
        tokens: args.slice(1),
        valid: Number(e.r) === 1,
      };
    default:
      return null;
  }
}

/**
 * Decode a list of log lines in RPUSH order, which is the server's execution order (Redis runs
 * scripts one at a time). Execution order, not timestamp order, is authoritative.
 */
export function decodeLog(lines: readonly string[]): ServerEvent[] {
  const out: ServerEvent[] = [];
  for (const line of lines) {
    const e = decodeEvent(line);
    if (e) out.push(e);
  }
  return out;
}
