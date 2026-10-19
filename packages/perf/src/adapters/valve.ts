// Valve under test, loaded from a build's dist/ so any ref or patch can be measured.
// Instruments only through public seams: a Store wrapper (call counts and timings, preserving
// whether sync admission exists) and the redisStore `adapter` evalsha seam (instrumented Lua
// substitution in correctness arms).
import { Redis } from 'ioredis';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CellSpec, RuleSpec } from '../core/types.ts';
import { instrumentAll } from '../lua/instrument.ts';
import { loadScripts } from '../lua/sources.ts';
import type {
  Adapter,
  AdapterContext,
  Limiter,
  SubmitOptions,
} from './types.ts';
import { readFileSync } from 'node:fs';
import { sha1 } from '../core/hash.ts';

type ValveModule = typeof import('valvejs');
type RedisModule = typeof import('valvejs/redis');
type Store = import('valvejs').Store;

const modules = new Map<string, Promise<[ValveModule, RedisModule]>>();
function load(packageDir: string) {
  let m = modules.get(packageDir);
  if (!m) {
    m = Promise.all([
      import(
        pathToFileURL(join(packageDir, 'dist/index.js')).href
      ) as Promise<ValveModule>,
      import(
        pathToFileURL(join(packageDir, 'dist/redis/index.js')).href
      ) as Promise<RedisModule>,
    ]);
    modules.set(packageDir, m);
  }
  return m;
}

const toRule = (r: RuleSpec) => ({
  limit: r.limit,
  interval: r.intervalMs,
  ...(r.burst !== undefined ? { burst: r.burst } : {}),
  ...(r.algorithm ? { algorithm: r.algorithm } : {}),
  ...(r.name ? { name: r.name } : {}),
  ...(r.scope ? { scope: r.scope } : {}),
});

/** Wrap a store to record every call. Optional sync methods are wrapped only if present. */
export function countingStore(
  store: Store,
  ctx: AdapterContext,
  decisionClock?: () => number | undefined,
): Store {
  const rec = (
    op: string,
    t0: number,
    g: number,
    n: number,
    ra: number,
    lb?: boolean,
    err?: string,
    gc?: number[],
  ) =>
    ctx.onCall({
      w: ctx.worker,
      op,
      t0,
      t1: ctx.now(),
      g,
      n,
      ra,
      ...(lb !== undefined ? { lb } : {}),
      ...(err ? { err } : {}),
      ...(gc ? { gc } : {}),
    });
  const wrapped: Store = {
    ...store,
    acquire: async (request) => {
      const t0 = ctx.now();
      try {
        const r = await store.acquire(request);
        rec(
          'acquire',
          t0,
          r.granted,
          request.costs.length,
          r.retryAfterMs,
          r.leaseBlocked,
          undefined,
          request.costs.slice(0, r.granted),
        );
        return r;
      } catch (error) {
        rec(
          'acquire',
          t0,
          0,
          request.costs.length,
          0,
          undefined,
          String((error as Error)?.message ?? error).slice(0, 80),
        );
        throw error;
      }
    },
  };
  // Read the clock tapped inside memoryStore, after admission. A pre-call Date.now()
  // can differ by a millisecond and manufacture an early-grant oracle violation.
  if (store.acquireSync)
    wrapped.acquireSync = (request) => {
      const t0 = ctx.now();
      const r = store.acquireSync!(request);
      const dn = decisionClock?.();
      const keys = request.rules.map((x) => x.key);
      ctx.onCall({
        w: ctx.worker,
        op: 'acquire',
        t0,
        t1: ctx.now(),
        g: r.granted,
        n: request.costs.length,
        ra: r.retryAfterMs,
        ...(r.leaseBlocked !== undefined ? { lb: r.leaseBlocked } : {}),
        ...(dn !== undefined ? { dn } : {}),
        gc: request.costs.slice(0, r.granted),
        gk: Array.from({ length: r.granted }, () => keys),
      });
      return r;
    };
  else delete wrapped.acquireSync;
  if (store.acquireScoped)
    wrapped.acquireScoped = async (request) => {
      const t0 = ctx.now();
      const r = await store.acquireScoped!(request);
      const ra = r.blocked.length
        ? Math.min(...r.blocked.map((b) => b.retryAfterMs))
        : 0;
      rec(
        'scoped',
        t0,
        r.grantedIndexes.length,
        request.jobs.length,
        ra,
        undefined,
        undefined,
        r.grantedIndexes.map((index) => request.jobs[index]!.cost),
      );
      return r;
    };
  if (store.acquireScopedSync)
    wrapped.acquireScopedSync = (request) => {
      const t0 = ctx.now();
      const r = store.acquireScopedSync!(request);
      const dn = decisionClock?.();
      const ra = r.blocked.length
        ? Math.min(...r.blocked.map((b) => b.retryAfterMs))
        : 0;
      const keysOf = (i: number) =>
        request.rules.map((x) =>
          x.scope ? `${x.key}:${request.jobs[i]!.scopes[x.scope]}` : x.key,
        );
      ctx.onCall({
        w: ctx.worker,
        op: 'scoped',
        t0,
        t1: ctx.now(),
        g: r.grantedIndexes.length,
        n: request.jobs.length,
        ra,
        ...(dn !== undefined ? { dn } : {}),
        gc: r.grantedIndexes.map((i) => request.jobs[i]!.cost),
        gk: r.grantedIndexes.map(keysOf),
      });
      return r;
    };
  else delete wrapped.acquireScopedSync;
  if (store.release)
    wrapped.release = async (id, leases) => {
      const t0 = ctx.now();
      await store.release!(id, leases);
      rec('release', t0, 0, leases.length, 0);
    };
  if (store.renew)
    wrapped.renew = async (id, leases, ttl) => {
      const t0 = ctx.now();
      const ok = await store.renew!(id, leases, ttl);
      rec('renew', t0, ok ? leases.length : 0, leases.length, 0);
      return ok;
    };
  return wrapped;
}

function needsRedis(cell: CellSpec) {
  return cell.store.kind === 'redis';
}

export const valveAdapter: Adapter = {
  id: 'valve',
  version: (() => {
    try {
      return (
        JSON.parse(
          readFileSync(
            new URL('../../../valve/package.json', import.meta.url),
            'utf8',
          ),
        ) as { version: string }
      ).version;
    } catch {
      return 'unknown';
    }
  })(),
  supports: () => true,
  async create(ctx: AdapterContext): Promise<Limiter> {
    const { cell } = ctx;
    const [valve, redisMod] = await load(ctx.valvePackageDir);
    const clients: Redis[] = [];
    let base: Store;
    let memoryClock: number | undefined;
    if (needsRedis(cell)) {
      if (!ctx.redisUrl) throw new Error('redis cell without redisUrl');
      const client = new Redis(ctx.redisUrl, {
        lazyConnect: true,
        enableOfflineQueue: true,
      });
      await client.connect();
      clients.push(client);
      const subscriber =
        cell.store.kind === 'redis' && cell.store.subscriber
          ? new Redis(ctx.redisUrl, { lazyConnect: true })
          : undefined;
      if (subscriber) {
        await subscriber.connect();
        clients.push(subscriber);
      }
      // Correctness arms substitute instrumented scripts by SHA; uninstrumented arms pass through.
      const inst = ctx.luaLogKey
        ? instrumentAll(loadScripts(ctx.valvePackageDir), ctx.luaLogKey)
        : undefined;
      const adapter = {
        evalsha: async (sha: string, keys: string[], args: string[]) => {
          const swap = inst?.get(sha);
          if (!swap) return client.evalsha(sha, keys.length, ...keys, ...args);
          try {
            return await client.evalsha(
              swap.sha,
              keys.length,
              ...keys,
              ...args,
            );
          } catch (error) {
            if (String((error as Error)?.message).includes('NOSCRIPT'))
              return client.eval(swap.source, keys.length, ...keys, ...args);
            throw error;
          }
        },
        eval: (script: string, keys: string[], args: string[]) =>
          client.eval(
            inst?.get(sha1(script))?.source ?? script,
            keys.length,
            ...keys,
            ...args,
          ),
      };
      base = redisMod.redisStore({
        adapter,
        prefix: ctx.keyPrefix,
        ...(subscriber ? { subscriber } : {}),
      } as Parameters<RedisModule['redisStore']>[0]);
    } else
      base = valve.memoryStore({
        clock: () => (memoryClock = Date.now()),
      });
    const store = countingStore(base, ctx, () => memoryClock);
    const concurrency =
      cell.concurrency === undefined
        ? undefined
        : typeof cell.concurrency === 'number'
          ? cell.concurrency
          : {
              limit: cell.concurrency.limit,
              scope: cell.concurrency.scope,
              ...(cell.concurrency.leaseTtlMs
                ? { leaseTtl: cell.concurrency.leaseTtlMs }
                : {}),
            };
    const v = valve.createValve({
      id: ctx.quotaId,
      store,
      ...(cell.rules?.length ? { rate: cell.rules.map(toRule) } : {}),
      ...(concurrency !== undefined ? { concurrency } : {}),
      ...(cell.batch ? { batch: cell.batch } : {}),
      ...(cell.maxQueue ? { maxQueue: cell.maxQueue } : {}),
    } as Parameters<ValveModule['createValve']>[0]);
    const wrapped = v.wrap((fn: () => unknown) => fn());
    const fetchJobs = new Map<string, { fn: () => unknown; value?: unknown }>();
    let requestId = 0;
    const wrappedFetch = v.wrapFetch(
      async (input: RequestInfo | URL) => {
        const key = String(input);
        const job = fetchJobs.get(key);
        if (!job) throw new Error('unrecognized harness fetch request');
        job.value = await job.fn();
        return new Response(null, { status: 200 });
      },
      { retries: 0 },
    );
    return {
      submit<T>(fn: () => T | Promise<T>, o: SubmitOptions) {
        if (cell.apiMode && cell.apiMode !== 'run') {
          if (
            o.cost !== 1 ||
            o.scopes ||
            o.maxWaitMs !== undefined ||
            o.priority !== undefined ||
            o.signal
          )
            return Promise.reject(
              new Error(
                'wrapper suite requires simple jobs without per-call admission options',
              ),
            );
          if (cell.apiMode === 'wrap') return wrapped(fn) as Promise<T>;
          const key = `https://valve-perf.invalid/${requestId++}`;
          const job = { fn, value: undefined as unknown };
          fetchJobs.set(key, job);
          return wrappedFetch(key)
            .then(() => job.value as T)
            .finally(() => fetchJobs.delete(key));
        }
        return v.run(fn, {
          ...(o.cost !== 1 ? { cost: o.cost } : {}),
          ...(o.priority !== undefined ? { priority: o.priority } : {}),
          ...(o.maxWaitMs !== undefined ? { maxWait: o.maxWaitMs } : {}),
          ...(o.signal ? { signal: o.signal } : {}),
          ...(o.scopes ? { scopes: o.scopes } : {}),
        }) as Promise<T>;
      },
      async control(action, durationMs = 100) {
        const t0 = ctx.now();
        if (action === 'pause') await v.pause(durationMs);
        else if (action === 'resume') await v.resume();
        else
          v.observe({
            status: 429,
            headers: { 'Retry-After': String(durationMs / 1000) },
          });
        ctx.onCall({
          w: ctx.worker,
          op: action,
          t0,
          t1: ctx.now(),
          g: 0,
          n: 0,
          ra: durationMs,
        });
      },
      async close() {
        try {
          await v.close();
          await store.close();
        } catch {
          // close must not reject
        }
        for (const c of clients) c.disconnect();
      },
      stats: () => ({
        ...v.stats().totals,
        queued: v.stats().queued,
        running: v.stats().running,
      }),
    };
  },
};
