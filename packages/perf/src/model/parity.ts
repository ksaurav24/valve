import { openSync, closeSync, rmSync, writeFileSync } from 'node:fs';
import { endpointLockPath } from '../infra/safety.ts';
// Trace adapters for independent model, public memory Store, and exact shipped Lua.
import fc from 'fast-check';
import { Redis } from 'ioredis';
import { memoryStore } from 'valvejs';
import type {
  AcquireRequest,
  ScopedAcquireRequest,
  NormalizedRule,
} from 'valvejs';
import { loadScripts } from '../lua/sources.ts';
import { withInjectedClock } from '../lua/clock.ts';
import { acquire, acquireScoped, pause, release, renew } from './admission.ts';
import type { ScopedRequest } from './admission.ts';
import { createState } from './state.ts';
/** Trace operations use relative milliseconds; each adapter receives the same epoch base. */
export type TraceOp = { at: number } & (
  | { op: 'acquire'; request: Omit<AcquireRequest, 'id'> }
  | { op: 'scoped'; request: Omit<ScopedAcquireRequest, 'id'> }
  | { op: 'pause'; ms: number }
  | { op: 'release'; tokens: readonly string[] }
  | { op: 'renew'; tokens: readonly string[]; ttlMs: number }
);
/** Compile valid public scoped requests into collision-free independent rule identities. */
export function prepareModelScoped(
  request: Omit<ScopedAcquireRequest, 'id'>,
): ScopedRequest {
  const rules: NormalizedRule[] = [],
    keys = new Map<string, number>();
  const jobs = request.jobs.map((job) => ({
    cost: job.cost,
    refs: request.rules.map((rule) => {
      const key =
        rule.scope === undefined
          ? `r:${rule.key}`
          : `s:${rule.key}:${encodeURIComponent(job.scopes[rule.scope]!)}`;
      let index = keys.get(key);
      if (index === undefined) {
        index = rules.length;
        keys.set(key, index);
        rules.push({ ...rule, key });
      }
      return index;
    }),
  }));
  return { rules, jobs, ...(request.lease ? { lease: request.lease } : {}) };
}
/** Run a validated chronological trace against the admission model. */
export function runModelTrace(trace: readonly TraceOp[], base = 0): unknown[] {
  const state = createState();
  return trace.map((event) => {
    const now = base + event.at;
    switch (event.op) {
      case 'acquire':
        return acquire(state, event.request, now);
      case 'scoped':
        return acquireScoped(state, prepareModelScoped(event.request), now);
      case 'pause':
        pause(state, event.ms, now);
        return null;
      case 'release':
        release(state, event.tokens, now);
        return null;
      case 'renew':
        return renew(state, event.tokens, event.ttlMs, now);
    }
  });
}
/** Run the same trace through public synchronous Store admission and async control methods. */
export async function runMemoryTrace(
  trace: readonly TraceOp[],
  base = 0,
): Promise<unknown[]> {
  let now = base;
  const store = memoryStore({ clock: () => now }),
    results: unknown[] = [];
  try {
    for (const event of trace) {
      now = base + event.at;
      switch (event.op) {
        case 'acquire': {
          const { leases, ...result } = store.acquireSync!({
            id: 'model',
            ...event.request,
          });
          results.push({ ...result, ...(leases ? { tokens: leases } : {}) });
          break;
        }
        case 'scoped': {
          const { leases, pausedMs, ...result } = store.acquireScopedSync!({
            id: 'model',
            ...event.request,
          });
          results.push({
            ...result,
            pausedMs: pausedMs ?? 0,
            ...(leases ? { tokens: leases } : {}),
          });
          break;
        }
        case 'pause':
          await store.pause('model', event.ms);
          results.push(null);
          break;
        case 'release':
          await store.release!('model', event.tokens);
          results.push(null);
          break;
        case 'renew':
          results.push(await store.renew!('model', event.tokens, event.ttlMs));
          break;
      }
    }
  } finally {
    await store.close();
  }
  return results;
}
/** Boundary points include exact eligibility, +/-1us, fixed edges and ceil(TAT) expiry. */
export function boundaryTimes(
  tat: number,
  rule: NormalizedRule,
  cost = 1,
): number[] {
  const eligibility =
    tat - ((rule.burst - cost) * rule.intervalMs) / rule.limit;
  const edge = Math.ceil(tat / rule.intervalMs) * rule.intervalMs;
  return [
    ...new Set([
      0,
      eligibility - 0.001,
      eligibility,
      eligibility + 0.001,
      edge - 0.001,
      edge,
      Math.ceil(tat) - 0.001,
      Math.ceil(tat),
    ]),
  ]
    .filter((t) => t >= 0)
    .sort((a, b) => a - b);
}
/** Shrinkable integer/fractional, edge-targeted static traces with weighted batches. */
export function traceArbitrary(
  rules: readonly NormalizedRule[],
): fc.Arbitrary<TraceOp[]> {
  const cap = Math.min(
    ...rules.map((r) => (r.algorithm === 'gcra' ? r.burst : r.limit)),
  );
  const points = rules.flatMap((r) => boundaryTimes(r.intervalMs, r));
  return fc
    .array(
      fc.record({
        at: fc.oneof(
          fc.constantFrom(...points),
          fc.integer({ min: 0, max: 1000 }),
          fc.integer({ min: 0, max: 1000000 }).map((n) => n / 1000),
        ),
        costs: fc.array(fc.integer({ min: 1, max: cap }), {
          minLength: 1,
          maxLength: 6,
        }),
      }),
      { minLength: 1, maxLength: 20 },
    )
    .map((events) =>
      events
        .sort((a, b) => a.at - b.at)
        .map((e) => ({
          at: e.at,
          op: 'acquire' as const,
          request: { rules, costs: e.costs },
        })),
    );
}
/** Only the two explicitly owned disposable endpoints may be used. */
export function assertDisposableUrl(url: string): void {
  if (!['redis://127.0.0.1:16479', 'redis://127.0.0.1:16480'].includes(url))
    throw new Error(`Not a harness-owned disposable endpoint: ${url}`);
}
/** Execute exact shipped script bodies in a wrapper that controls key lifetimes.
 * TIME injection does not virtualize Redis expiry. Read TIME once and run >=1e6ms
 * ahead of it; PERSIST state after each call, and delete only each key whose
 * independently read expiry has elapsed before the next call. Pause PX is set in
 * the same EVAL wrapper, where Redis's real millisecond snapshot is frozen.
 * renew's trailing clock would be treated as a token: add an isolated sentinel
 * member named by that clock, execute the unmodified loop, then remove it. It is
 * never visible to admission; raw false-without-sentinel is tested separately.
 */
export async function runRedisTrace(
  url: string,
  trace: readonly TraceOp[],
  packageDir: string,
  prefix: string,
  epochBase?: number,
): Promise<{ base: number; results: unknown[] }> {
  assertDisposableUrl(url);
  if (!/^perf-model-test:[\w-]+$/.test(prefix))
    throw new Error('A unique perf-model-test prefix is required');
  // Share the supervisor's endpoint lock: a concurrent disposable FLUSHDB
  // would erase this prefix mid-trace and manufacture a parity failure.
  const lock = endpointLockPath(url);
  const fd = openSync(lock, 'wx');
  writeFileSync(
    fd,
    JSON.stringify({ pid: process.pid, purpose: 'model-parity' }),
  );
  closeSync(fd);
  const io = new Redis(url, { maxRetriesPerRequest: 0 });
  try {
    const sources = loadScripts(packageDir);
    const time = await io.time();
    const base =
      epochBase ??
      (Math.ceil((Number(time[0]) * 1000) / 1000000) + 1) * 1000000;
    const root = `${prefix}:{model}`,
      pauseKey = `${root}:pause`,
      leaseKey = `${root}:leases`,
      configKey = `${root}:config`,
      channel = `${root}:events`;
    const expires = new Map<string, number>(),
      results: unknown[] = [];
    let until = 0;
    try {
      for (const event of trace) {
        const now = base + event.at;
        for (const [key, end] of expires)
          if (end <= now) {
            await io.unlink(key);
            expires.delete(key);
          }
        let keys: string[], args: (string | number)[], source: string;
        let ruleKeys: string[] = [],
          rules: readonly NormalizedRule[] = [];
        switch (event.op) {
          case 'acquire': {
            rules = event.request.rules;
            ruleKeys = rules.map((r) => `${root}:r:${r.key}`);
            keys = [
              pauseKey,
              ...ruleKeys,
              ...(event.request.lease ? [leaseKey] : []),
              configKey,
            ];
            const fingerprint = `${rules.some((r) => r.name) ? 'named-v1' : 'v1'}:[${rules
              .map((r) =>
                JSON.stringify([
                  r.algorithm,
                  r.intervalMs,
                  r.limit,
                  r.burst,
                  ...(r.name ? [r.name] : []),
                ]),
              )
              .sort()
              .join(
                ',',
              )}]:${event.request.lease ? `${event.request.lease.limit}:${event.request.lease.ttlMs}` : 'local'}`;
            args = [
              fingerprint,
              ...(event.request.lease
                ? [
                    'leases',
                    event.request.lease.limit,
                    event.request.lease.ttlMs,
                    event.request.lease.owner,
                  ]
                : []),
              ...rules.flatMap((r) => [
                r.algorithm === 'gcra' ? 0 : 1,
                r.intervalMs,
                r.limit,
                r.burst,
              ]),
              event.request.costs.length,
              ...event.request.costs,
              now,
            ];
            source = withInjectedClock(sources.ACQUIRE.source).source;
            break;
          }
          case 'scoped': {
            const plan = prepareModelScoped(event.request);
            rules = plan.rules as NormalizedRule[];
            ruleKeys = rules.map((r) => `${root}:${r.key}`);
            keys = [configKey, pauseKey, leaseKey, ...ruleKeys];
            const fingerprint = `scoped-v1:${JSON.stringify(event.request.rules.map((r) => [r.key, r.scope ?? null, r.algorithm, r.intervalMs, r.limit, r.burst]).sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)))}:${event.request.lease ? `${event.request.lease.limit}:${event.request.lease.ttlMs}` : 'local'}`;
            args = [JSON.stringify({ ...plan, fingerprint }), now];
            source = withInjectedClock(sources.SCOPED.source).source;
            break;
          }
          case 'release':
            keys = [leaseKey, channel];
            args = [...event.tokens];
            source = sources.RELEASE.source;
            break;
          case 'pause':
            keys = [pauseKey, channel];
            args = [event.ms];
            source = sources.PAUSE.source;
            break;
          case 'renew':
            keys = [leaseKey];
            args = [event.ttlMs, ...event.tokens, now];
            source = withInjectedClock(sources.RENEW.source).source;
            break;
        }
        const sentinel =
          event.op === 'renew'
            ? `redis.call('ZADD', ${JSON.stringify(leaseKey)}, ${now + 1}, ARGV[#ARGV])`
            : '';
        const removeSentinel =
          event.op === 'renew'
            ? `redis.call('ZREM', ${JSON.stringify(leaseKey)}, ARGV[#ARGV])`
            : '';
        const remaining = Math.max(0, until - Math.floor(now));
        const wrapper = `redis.call('DEL', ${JSON.stringify(pauseKey)})\n${remaining > 0 ? `redis.call('SET', ${JSON.stringify(pauseKey)}, '1', 'PX', ${remaining})` : ''}\n${sentinel}\nlocal function run()\n${source}\nend\nlocal answer = run()\n${removeSentinel}\nreturn {answer, redis.call('PTTL', ${JSON.stringify(pauseKey)})}`;
        const [raw, ttl] = (await io.eval(
          wrapper,
          keys.length,
          ...keys,
          ...args,
        )) as [unknown, number];
        if (event.op === 'pause') {
          until = Math.floor(now) + Math.max(0, ttl);
          results.push(null);
        } else if (event.op === 'release') results.push(null);
        else if (event.op === 'renew') results.push(raw === 1);
        else if (event.op === 'acquire') {
          const [granted, retryAfterMs, pausedMs, tokens, blocked] = raw as [
            number,
            number,
            number,
            string[]?,
            number?,
          ];
          results.push({
            granted,
            retryAfterMs,
            pausedMs,
            ...(event.request.lease && !pausedMs
              ? { tokens: tokens ?? [], leaseBlocked: blocked === 1 }
              : {}),
          });
        } else {
          const [grantedIndexes, blocked, tokens, pausedMs] = raw as [
            number[],
            [number, number, number?][],
            [number, string][],
            number,
          ];
          results.push({
            grantedIndexes,
            blocked: blocked.map(([index, retryAfterMs, lb]) => ({
              index,
              retryAfterMs,
              ...(event.request.lease ? { leaseBlocked: lb === 1 } : {}),
            })),
            pausedMs,
            ...(event.request.lease
              ? { tokens: tokens.map(([index, token]) => ({ index, token })) }
              : {}),
          });
        }
        for (let i = 0; i < rules.length; i++) {
          const rule = rules[i]!,
            key = ruleKeys[i]!;
          if (rule.algorithm === 'gcra') {
            const tat = await io.get(key);
            if (tat !== null) expires.set(key, Math.ceil(Number(tat)));
          } else {
            const ttlMs = await io.pttl(key);
            if (ttlMs >= 0)
              expires.set(
                key,
                event.op === 'scoped'
                  ? Math.ceil(
                      (Number(await io.hget(key, 'w')) + 1) * rule.intervalMs,
                    )
                  : Math.floor(now) + ttlMs,
              );
          }
          await io.persist(key);
        }
        await io.persist(leaseKey);
      }
      return { base, results };
    } finally {
      let cursor = '0';
      do {
        const [next, keys] = await io.scan(
          cursor,
          'MATCH',
          `${prefix}:*`,
          'COUNT',
          100,
        );
        cursor = next;
        if (keys.length) await io.unlink(...keys);
      } while (cursor !== '0');
      await io.quit();
    }
  } finally {
    io.disconnect();
    rmSync(lock, { force: true });
  }
}
