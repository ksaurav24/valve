#!/usr/bin/env node
// Run: REDIS_URL=redis://127.0.0.1:26379 pnpm --filter @valve/perf exec tsx src/measure/managed.ts
// Local admission comparison; use a dedicated Redis. No production endpoint is implied.
import { Bench } from 'tinybench';
import { Redis } from 'ioredis';
import { memoryStore } from 'valvejs';
import { redisStore } from 'valvejs/redis';
import type { Store, NormalizedRule } from 'valvejs';

const prefix = `managed-bench-${crypto.randomUUID()}`;
const client = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL)
  : undefined;
const rows: Record<string, unknown>[] = [];
try {
  for (const backend of client ? ['memory', 'redis'] : ['memory']) {
    for (const scoped of [false, true]) {
      for (const batch of [1, 32]) {
        const bench = new Bench({
          time: 1000,
          warmupTime: 250,
          iterations: 100,
          retainSamples: true,
        });
        const stores: Store[] = [];
        for (const managed of [false, true]) {
          const store =
            backend === 'redis'
              ? redisStore({ client: client!, prefix })
              : memoryStore();
          stores.push(store);
          const id = `${backend}-${scoped}-${batch}-${managed}`;
          const rules: readonly NormalizedRule[] = Object.freeze([
            Object.freeze({
              name: 'budget',
              key: 'named:budget',
              algorithm: 'gcra',
              limit: 1000,
              intervalMs: 1000,
              burst: 1_000_000_000,
              ...(scoped ? { scope: 'recipient' } : {}),
            }),
          ]);
          const capability = managed ? store.managed! : store;
          const known = managed
            ? (await store.managed!.getLimits({ id, rules })).version
            : undefined;
          const context = { id, rules, ...(known ? { known } : {}) };
          const request = { ...context, costs: Array<number>(batch).fill(1) };
          const scopedRequest = {
            ...context,
            jobs: Array.from({ length: batch }, (_, i) => ({
              cost: 1,
              scopes: { recipient: `r${i}` },
            })),
          };
          const run =
            backend === 'memory'
              ? () =>
                  scoped
                    ? capability.acquireScopedSync!(scopedRequest)
                    : capability.acquireSync!(request)
              : () =>
                  scoped
                    ? capability.acquireScoped!(scopedRequest)
                    : capability.acquire(request);
          const first = await run();
          if (
            'granted' in first
              ? first.granted !== batch
              : first.grantedIndexes.length !== batch
          )
            throw new Error('Benchmark must measure successful admission.');
          bench.add(managed ? 'managed' : 'immutable', run);
        }
        await bench.run();
        for (const task of bench.tasks) {
          const result = task.result;
          if (result.state !== 'completed')
            throw new Error('Incomplete benchmark');
          rows.push({
            backend,
            scoped,
            batch,
            mode: task.name,
            usPerAdmission: result.latency.mean * 1000,
            rme: result.latency.rme,
            samples: result.latency.samplesCount,
          });
        }
        await Promise.all(stores.map((store) => store.close()));
      }
    }
  }
  console.log(JSON.stringify({ node: process.version, rows }, null, 2));
} finally {
  if (client) {
    const keys = await client.keys(`${prefix}:*`);
    if (keys.length) await client.del(...keys);
    await client.quit();
  }
}
