// Regression check for the maxWait check-to-callback gap fixed in valvejs 0.5.2.
// The first callback blocks through the second job's deadline. Passing requires the first
// job to finish and the second to reject with MAX_WAIT_EXCEEDED without invoking its body.
import { Redis } from 'ioredis';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BuildIdentity, SafetyStatus } from '../core/types.ts';
import { cleanupPrefix } from '../infra/safety.ts';

export interface C1Result {
  store: string;
  maxWaitMs: number;
  spinMs: number;
  /** Callback start minus (submit + maxWait), ms; > 0 means the defect reproduced. */
  lateMs: number;
  reproduced: boolean;
  outcome: 'started' | 'rejected';
  firstOutcome: 'fulfilled' | 'rejected';
  blockedThroughDeadline: boolean;
  rejectionCode?: string;
  safety: SafetyStatus;
}

const now = () => performance.timeOrigin + performance.now();

export function classifyC1(
  result: Pick<
    C1Result,
    | 'lateMs'
    | 'outcome'
    | 'firstOutcome'
    | 'blockedThroughDeadline'
    | 'rejectionCode'
  >,
): SafetyStatus {
  if (result.lateMs > 0) return 'FAIL';
  return result.firstOutcome === 'fulfilled' &&
    result.blockedThroughDeadline &&
    result.outcome === 'rejected' &&
    result.rejectionCode === 'MAX_WAIT_EXCEEDED'
    ? 'PASS'
    : 'UNVERIFIED';
}

/** Older evidence without a verified rejection stays unverified; a late callback always fails. */
export function c1Safety(
  results: readonly { reproduced: boolean; safety?: SafetyStatus }[],
): SafetyStatus {
  if (results.some((r) => r.reproduced || r.safety === 'FAIL')) return 'FAIL';
  return results.length > 0 && results.every((r) => r.safety === 'PASS')
    ? 'PASS'
    : 'UNVERIFIED';
}

/** Check any build, retaining FAIL for vulnerable historical builds. */
export async function reproduceC1(
  build: Pick<BuildIdentity, 'packageDir'>,
  options: {
    redisUrl?: string;
    maxWaitMs?: number;
    spinMs?: number;
    prefix?: string;
  } = {},
): Promise<C1Result> {
  const maxWaitMs = options.maxWaitMs ?? (options.redisUrl ? 100 : 10);
  const spinMs = options.spinMs ?? maxWaitMs + 30;
  if (!(maxWaitMs > 0 && spinMs > maxWaitMs))
    throw new Error('C1 repro requires spinMs > maxWaitMs > 0');
  const valve = (await import(
    pathToFileURL(join(build.packageDir, 'dist/index.js')).href
  )) as typeof import('valvejs');
  let client: Redis | undefined;
  let store: import('valvejs').Store;
  const prefix = options.prefix ?? `vp-c1-${process.pid}-${Date.now()}`;
  if (options.redisUrl) {
    const redis = (await import(
      pathToFileURL(join(build.packageDir, 'dist/redis/index.js')).href
    )) as typeof import('valvejs/redis');
    client = new Redis(options.redisUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
    });
    store = redis.redisStore({ client, prefix } as Parameters<
      typeof redis.redisStore
    >[0]);
  } else store = valve.memoryStore();
  // Both jobs fit in one admission batch: concurrency 2, generous burst.
  const v = valve.createValve({
    id: `c1-${Date.now()}`,
    rate: { limit: 100, interval: 1000, burst: 10 },
    concurrency: 2,
    onStoreError: 'throw',
    store,
  });
  try {
    // Open connections, load Lua and warm the public API before the short deadline.
    await v.run(() => undefined);
    let startedAt = -1;
    let blockedUntil = -1;
    const first = v.run(() => {
      const until = performance.now() + spinMs;
      while (performance.now() < until);
      blockedUntil = now();
    });
    const submittedAt = now();
    const second = v.run(
      () => {
        startedAt = now();
      },
      { maxWait: maxWaitMs },
    );
    const [a, b] = await Promise.allSettled([first, second]);
    const outcome =
      b.status === 'fulfilled' ? ('started' as const) : ('rejected' as const);
    const rejectionCode =
      b.status === 'rejected' && typeof b.reason?.code === 'string'
        ? (b.reason.code as string)
        : undefined;
    const lateMs = startedAt < 0 ? 0 : startedAt - submittedAt - maxWaitMs;
    const observed = {
      store: options.redisUrl ? 'redis' : 'memory',
      maxWaitMs,
      spinMs,
      lateMs,
      reproduced: lateMs > 0,
      outcome,
      firstOutcome: a.status,
      blockedThroughDeadline: blockedUntil > submittedAt + maxWaitMs,
      ...(rejectionCode ? { rejectionCode } : {}),
    };
    return { ...observed, safety: classifyC1(observed) };
  } finally {
    await v.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    if (client) {
      await cleanupPrefix(client, prefix).catch(() => undefined);
      client.disconnect();
    }
  }
}
