// Focused reproduction of the inherited maxWait check-to-callback gap (C1).
// Valve checks a job's deadline when the admission reply is handled (valve.ts `start()`), then
// runs the callback in a later microtask after the batch's earlier callbacks. If an earlier
// callback in the same batch does synchronous work past the deadline, the later callback starts
// after its maxWait. This is a correctness failure; it is reported, never waived.
import { Redis } from 'ioredis';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BuildIdentity } from '../core/types.ts';
import { cleanupPrefix } from '../infra/safety.ts';

export interface C1Result {
  store: string;
  maxWaitMs: number;
  spinMs: number;
  /** Callback start minus (submit + maxWait), ms; > 0 means the defect reproduced. */
  lateMs: number;
  reproduced: boolean;
  outcome: 'started' | 'rejected';
}

const now = () => performance.timeOrigin + performance.now();

/** Run the reproduction against a build's memory store, or Redis when `redisUrl` is given. */
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
    // Open the connection and load Lua before testing the short callback deadline.
    if (client) await v.run(() => undefined);
    let startedAt = -1;
    const first = v.run(() => {
      const until = performance.now() + spinMs;
      while (performance.now() < until);
    });
    const submittedAt = now();
    const second = v.run(
      () => {
        startedAt = now();
      },
      { maxWait: maxWaitMs },
    );
    const outcome = await Promise.all([first, second]).then(
      () => 'started' as const,
      () => 'rejected' as const,
    );
    const lateMs = startedAt < 0 ? 0 : startedAt - submittedAt - maxWaitMs;
    return {
      store: options.redisUrl ? 'redis' : 'memory',
      maxWaitMs,
      spinMs,
      lateMs,
      reproduced: lateMs > 0,
      outcome,
    };
  } finally {
    await v.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    if (client) {
      await cleanupPrefix(client, prefix).catch(() => undefined);
      client.disconnect();
    }
  }
}

export const C1_ISSUE = `C1: a job's callback can start after its maxWait.

Location: packages/valve/src/valve.ts start() checks \`job.deadline <= Date.now()\` when the store
reply is handled, then runs the callback in a later microtask (queueMicrotask), after earlier
callbacks of the same granted batch. Synchronous work in an earlier callback, or any event-loop
stall between the check and the microtask, makes the later callback start after its deadline.

Repro: \`pnpm perf c1\` (memory store and Redis), or packages/perf/test/c1.repro.test.ts.
Prior evidence: forced 21-26 ms late; 3 natural occurrences ≤ 0.26 ms (slotExp validation, 2026-10-19).

Options to evaluate (not decided here): re-check the deadline inside the callback microtask
before invoking fn (reject with MAX_WAIT_EXCEEDED and release any lease/budget accounting as
documented for cancelled grants); or document maxWait as a bound on admission, not on callback start.`;
