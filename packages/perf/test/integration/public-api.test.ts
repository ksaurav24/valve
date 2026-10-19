import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { currentBuild } from '../../src/identity/build.ts';
import { valveAdapter } from '../../src/adapters/valve.ts';
import type { AdapterContext, Limiter } from '../../src/adapters/types.ts';
import { resolveEndpoint, cleanupPrefix } from '../../src/infra/safety.ts';
import { Redis } from 'ioredis';
import type { CellSpec } from '../../src/core/types.ts';

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
describe.skipIf(process.env.PERF_INTEGRATION !== '1')(
  'Valve public execution and feedback seams',
  () => {
    for (const apiMode of ['wrap', 'wrapFetch'] as const)
      it(`${apiMode} runs the same body and returns its result`, async () => {
        const cell: CellSpec = {
          apiMode,
          id: 'api/test',
          suite: 'api',
          library: 'valve',
          mechanism: 'local-concurrency',
          workers: 1,
          concurrency: 2,
          store: { kind: 'memory' },
          workload: {
            arrival: { kind: 'backlog', depth: 2 },
            job: { kind: 'noop' },
          },
          timing: { warmupMs: 0, windowMs: 100, drainMs: 50 },
          priority: 0,
          tags: [],
        };
        const limiter = await valveAdapter.create({
          cell,
          worker: 0,
          instance: 0,
          quotaId: randomUUID(),
          keyPrefix: `public-api-${randomUUID()}`,
          valvePackageDir: currentBuild({ rebuild: false }).packageDir,
          now: () => performance.timeOrigin + performance.now(),
          onCall() {},
        });
        try {
          expect(await limiter.submit(async () => 42, { cost: 1 })).toBe(42);
          await expect(
            limiter.submit(
              () => {
                throw new Error('body failure');
              },
              { cost: 1 },
            ),
          ).rejects.toThrow('body failure');
        } finally {
          await limiter.close();
        }
      });
    for (const server of ['redis74', 'valkey8'])
      it(`${server}: pause, resume and Retry-After feedback govern another instance`, async () => {
        const endpoint = resolveEndpoint(server),
          prefix = `public-api-${randomUUID()}`,
          quotaId = randomUUID();
        const cell: CellSpec = {
          id: 'api/pause',
          suite: 'api',
          library: 'valve',
          mechanism: 'gcra',
          workers: 2,
          rules: [{ limit: 1000, intervalMs: 1000, burst: 20 }],
          concurrency: 2,
          store: { kind: 'redis', server, subscriber: true },
          workload: {
            arrival: { kind: 'backlog', depth: 2 },
            job: { kind: 'noop' },
          },
          timing: { warmupMs: 0, windowMs: 100, drainMs: 50 },
          priority: 0,
          tags: [],
        };
        const ctx: AdapterContext = {
          cell,
          worker: 0,
          instance: 0,
          quotaId,
          keyPrefix: prefix,
          redisUrl: endpoint.url,
          valvePackageDir: currentBuild({ rebuild: false }).packageDir,
          now: () => performance.timeOrigin + performance.now(),
          onCall() {},
        };
        const limiters: Limiter[] = [];
        const admin = new Redis(endpoint.url);
        try {
          limiters.push(
            await valveAdapter.create(ctx),
            await valveAdapter.create({ ...ctx, worker: 1 }),
          );
          await limiters[0]!.control!('pause', 250);
          await expect(
            limiters[1]!.submit(() => 'must not run', {
              cost: 1,
              maxWaitMs: 40,
            }),
          ).rejects.toMatchObject({ code: 'MAX_WAIT_EXCEEDED' });
          await limiters[0]!.control!('resume');
          expect(
            await limiters[1]!.submit(() => 'resumed', {
              cost: 1,
              maxWaitMs: 100,
            }),
          ).toBe('resumed');
          await limiters[0]!.control!('observe', 250);
          await sleep(15); // observe intentionally writes feedback to the store asynchronously.
          await expect(
            limiters[1]!.submit(() => 'must not run', {
              cost: 1,
              maxWaitMs: 40,
            }),
          ).rejects.toMatchObject({ code: 'MAX_WAIT_EXCEEDED' });
        } finally {
          await Promise.all(limiters.map((l) => l.close()));
          await cleanupPrefix(admin, prefix);
          admin.disconnect();
        }
      });
  },
);
