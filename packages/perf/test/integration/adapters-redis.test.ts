import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { bottleneckAdapter } from '../../src/adapters/bottleneck.ts';
import { CATEGORIES } from '../../src/adapters/registry.ts';
import type { Limiter } from '../../src/adapters/types.ts';

const url = 'redis://127.0.0.1:16479';
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function keysFor(redis: Redis, id: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const page = await redis.scan(cursor, 'MATCH', `b_${id}_*`, 'COUNT', 100);
    cursor = page[0];
    keys.push(...page[1]);
  } while (cursor !== '0');
  return keys;
}
describe.skipIf(process.env.PERF_INTEGRATION !== '1')(
  'Bottleneck ioredis clustering on Redis 7.4',
  () => {
    for (const category of ['D1', 'D2', 'D3']) {
      it(`${category} shares quota across three independent connections and releases them`, async () => {
        const id = `perf-adapter-${category}-${randomUUID()}`;
        const redis = new Redis(url);
        const limiters: Limiter[] = [];
        const cell = CATEGORIES.find((c) => c.id === category)!.buildCell({
          ...(category === 'D1'
            ? { concurrency: { limit: 2, scope: 'global' } }
            : {
                rules: [
                  {
                    limit: 2,
                    intervalMs: category === 'D2' ? 120 : 1000,
                    ...(category === 'D3'
                      ? { algorithm: 'fixed-window' as const }
                      : { burst: 1 }),
                  },
                ],
              }),
        });
        expect(bottleneckAdapter.supports(cell)).toBe(true);
        const starts: number[] = [];
        let running = 0;
        let peak = 0;
        try {
          expect(await redis.info('server')).toContain('redis_version:7.4.');
          for (let i = 0; i < 3; i++)
            limiters.push(
              await bottleneckAdapter.create({
                cell,
                worker: i,
                instance: 0,
                quotaId: id,
                keyPrefix: id,
                redisUrl: url,
                valvePackageDir: '',
                onCall() {},
                now: () => performance.timeOrigin + performance.now(),
              }),
            );
          // Every limiter has its own command + subscription connection (IORedisConnection duplicates).
          const clients = (await redis.client('LIST')) as string;
          const baselineClients = clients.trim().split('\n').length;
          expect(await keysFor(redis, id)).not.toHaveLength(0);
          await Promise.all(
            Array.from({ length: 9 }, (_, i) =>
              limiters[i % 3]!.submit(
                async () => {
                  starts.push(performance.now());
                  peak = Math.max(peak, ++running);
                  try {
                    await sleep(category === 'D1' ? 35 : 1);
                  } finally {
                    running--;
                  }
                },
                { cost: 1 },
              ),
            ),
          );
          starts.sort((a, b) => a - b);
          if (category === 'D1') expect(peak).toBe(2);
          if (category === 'D2')
            for (let i = 1; i < starts.length; i++)
              expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(57);
          if (category === 'D3') {
            // Refresh happens on datastore operations/heartbeat. Saturated windows may refresh late,
            // but can never issue a third unit before the shared refresh boundary.
            for (let i = 2; i < starts.length; i += 2)
              expect(starts[i]! - starts[i - 2]!).toBeGreaterThanOrEqual(970);
          }
          await Promise.all(limiters.map((limiter) => limiter.close()));
          await sleep(30);
          const afterClients = ((await redis.client('LIST')) as string)
            .trim()
            .split('\n').length;
          expect(afterClients).toBeLessThanOrEqual(baselineClients - 6);
        } finally {
          await Promise.all(limiters.map((limiter) => limiter.close()));
          // Bottleneck retains shared state on disconnect: only the trial owner cleans it after ALL
          // instances close. Never delete shared quota state from an individual adapter.close().
          const keys = await keysFor(redis, id);
          if (keys.length) await redis.unlink(...keys);
          expect(await keysFor(redis, id)).toEqual([]);
          await redis.quit();
        }
      });
    }
  },
);
