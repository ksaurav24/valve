import { createRequire } from 'node:module';
import Bottleneck from 'bottleneck';
import { Redis } from 'ioredis';
import { commonGap, concurrencyOf, weighted } from './plimit.ts';
import type { Adapter } from './types.ts';
import type { RuleSpec } from '../core/types.ts';
const require = createRequire(import.meta.url);

/** Valve higher-first -> Bottleneck lower-first. Saturates outside [-4,5]; ties collapse. */
export function bottleneckPriority(priority = 0): number {
  // Installed bottleneck/lib/Bottleneck.js:31-32; lib/Job.js:34-43 (0..9, default 5).
  return Math.max(0, Math.min(9, 5 - Math.trunc(priority)));
}
export function burstBankOptions(
  rule: RuleSpec,
): Bottleneck.ConstructorOptions {
  // lib/LocalDatastore.js:29-54; lib/Bottleneck.js:565: heartbeat is 250ms.
  // One integral R-token refill per I, rounded up to a heartbeat multiple.
  return {
    reservoir: rule.burst ?? 1,
    reservoirIncreaseInterval: Math.ceil(rule.intervalMs / 250) * 250,
    reservoirIncreaseAmount: rule.limit,
    reservoirIncreaseMaximum: rule.burst ?? 1,
  };
}
export const bottleneckAdapter: Adapter = {
  id: 'bottleneck',
  version: (require('bottleneck/package.json') as { version: string }).version,
  supports(cell) {
    const gap = commonGap(cell);
    if (gap) return gap;
    if (cell.workload.abort || cell.category === 'L5')
      return 'No queued AbortSignal cancellation';
    const rule = cell.rules?.[0];
    if (
      weighted(cell) &&
      (concurrencyOf(cell) !== undefined ||
        !rule ||
        !['window', 'fixed-window', 'burst-bank'].includes(cell.mechanism))
    )
      return 'Weight consumes both maxConcurrent and reservoir; only rate-reservoir cost alone is comparable';
    if (
      weighted(cell) &&
      cell.workload.job.costs?.values.some(
        (c) =>
          !Number.isInteger(c) ||
          c <= 0 ||
          c > Math.min(rule!.limit, rule!.burst ?? rule!.limit),
      )
    )
      return 'Reservoir costs must be positive integers within capacity';
    if (
      rule &&
      (!Number.isInteger(rule.limit) ||
        rule.limit <= 0 ||
        (rule.burst !== undefined &&
          (!Number.isInteger(rule.burst) || rule.burst <= 0)))
    )
      return 'Reservoir amounts must be positive integers';
    if (
      cell.store.kind === 'memory' &&
      typeof cell.concurrency === 'object' &&
      cell.concurrency.scope === 'global'
    )
      return 'Global concurrency requires Redis clustering';
    if (
      cell.store.kind === 'redis' &&
      cell.concurrency !== undefined &&
      typeof cell.concurrency !== 'object'
    )
      return 'Distributed concurrency must explicitly use global scope';
    if (
      cell.store.kind === 'redis' &&
      typeof cell.concurrency === 'object' &&
      cell.concurrency.scope !== 'global'
    )
      return 'Clustering applies maxConcurrent globally, not locally';
    if (rule && concurrencyOf(cell) !== undefined)
      return 'Rate plus lease is Valve-only';
    if (
      cell.category &&
      !['L1', 'L2', 'L3', 'L4', 'D1', 'D2', 'D3'].includes(cell.category)
    )
      return 'Unsupported comparison category';
    if (
      cell.store.kind === 'redis' &&
      (cell.category === 'L4' ||
        cell.mechanism === 'burst-bank' ||
        (rule?.burst ?? 1) > 1)
    )
      return 'Burst-bank comparison is local and approximate only';
    if (!rule && !concurrencyOf(cell))
      return 'Requires a rate rule or concurrency limit';
    return true;
  },
  async create(ctx) {
    const cell = ctx.cell;
    const rule = cell.rules?.[0];
    // Installed lib/Bottleneck.js:549-576; LocalDatastore.js:214-222.
    const options: Bottleneck.ConstructorOptions = {
      ...(concurrencyOf(cell) === undefined
        ? {}
        : { maxConcurrent: concurrencyOf(cell)! }),
      ...(rule
        ? cell.category === 'L4' ||
          cell.mechanism === 'burst-bank' ||
          (rule.burst ?? 1) > 1
          ? burstBankOptions(rule)
          : rule.algorithm === 'fixed-window' ||
              ['L3', 'D3'].includes(cell.category ?? '')
            ? {
                reservoir: rule.limit,
                reservoirRefreshAmount: rule.limit,
                reservoirRefreshInterval: rule.intervalMs,
              }
            : { minTime: rule.intervalMs / rule.limit }
        : {}),
    };
    let connection: Bottleneck.IORedisConnection | undefined;
    if (cell.store.kind === 'redis') {
      // Endpoint safety (disposable guard, prefix cleanup of `b_<id>` keys) is enforced by the trial supervisor.
      if (!ctx.redisUrl)
        throw new Error('distributed Bottleneck cell without redisUrl');
      if (!/^[\w:.-]+$/.test(ctx.quotaId))
        throw new Error('quotaId must be safe for isolated Bottleneck keys');
      // ioredis/built/Redis.js:664-676 accepts URL; Bottleneck/lib/IORedisConnection.js:22-49
      // accepts {client, Redis}, duplicates client for subscriptions. No node-redis.
      const client = new Redis(ctx.redisUrl);
      connection = new Bottleneck.IORedisConnection({ client, Redis });
      // lib/Bottleneck.js:60-63,567-581; lib/RedisDatastore.js:29-54: connection + id.
      Object.assign(options, {
        datastore: 'ioredis',
        connection,
        id: ctx.quotaId,
      });
    }
    const limiter = new Bottleneck(options);
    try {
      await limiter.ready();
    } catch (error) {
      await connection?.disconnect(false).catch(() => {
        /* disconnected during failed setup */
      });
      throw error;
    }
    let closed = false;
    return {
      submit(fn, options) {
        // lib/LocalDatastore.js:214-222: weight consumes reservoir AND running slots.
        // lib/Bottleneck.js:195-203: expiration is execution timeout, never maxWait.
        return limiter.schedule(
          {
            weight: options.cost,
            priority: bottleneckPriority(options.priority),
          },
          async () => fn(),
        );
      },
      async close() {
        if (closed) return;
        closed = true;
        // lib/Bottleneck.js:289-357; RedisDatastore.js:143-150: provided connection is shared,
        // so limiter.disconnect alone does NOT close it. IORedisConnection.js:150-167.
        try {
          await limiter.stop({ dropWaitingJobs: true });
        } catch {
          /* already stopped */
        }
        try {
          await limiter.disconnect();
        } catch {
          /* connection already closed */
        }
        try {
          await connection?.disconnect();
        } catch {
          await connection?.disconnect(false).catch(() => {
            /* already disconnected */
          });
        }
      },
      stats: () => ({ queued: limiter.queued() }),
    };
  },
};
