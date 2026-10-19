// Admission-only probe through the public Store contract. Denials are evaluations, not throughput.
import { Redis } from 'ioredis';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { NormalizedRule, ScopedAcquireRequest, Store } from 'valvejs';
import type { BuildIdentity } from '../core/types.ts';
import { cleanupPrefix, resolveEndpoint } from '../infra/safety.ts';

/** Construct immutable public Store policies matching Valve's scoped configuration shape. */
export function scopedRules(count: number): readonly NormalizedRule[] {
  const rules: NormalizedRule[] = Array.from({ length: count }, (_, i) => ({
    name: i ? `r${i}` : 'shared',
    key: `named:${i ? `r${i}` : 'shared'}`,
    ...(i ? { scope: 'recipient' } : {}),
    algorithm: i ? 'gcra' : 'fixed-window',
    limit: i ? 1 : 1_000_000_000,
    intervalMs: 86_400_000,
    burst: 1,
  }));
  // Match the immutable policy supplied by createValve without importing its normalizer.
  return Object.freeze(rules.map((rule) => Object.freeze(rule)));
}

export const expectedGrants = (evaluated: number, workload: string) =>
  workload === 'cold'
    ? evaluated
    : workload === 'hot'
      ? 1
      : Math.floor(evaluated / 2) + 1;

/** Check grants and measure scoped admission cardinality and contention using only public Store operations. */
export async function scopedProbe(
  artifact: BuildIdentity,
  options: {
    store: string;
    prefix: string;
    iterations: number;
  },
) {
  const { memoryStore } = (await import(
    pathToFileURL(join(artifact.packageDir, 'dist/index.js')).href
  )) as typeof import('valvejs');
  const { redisStore } = (await import(
    pathToFileURL(join(artifact.packageDir, 'dist/redis/index.js')).href
  )) as typeof import('valvejs/redis');
  const endpoint =
    options.store === 'memory' ? undefined : resolveEndpoint(options.store);
  const connections: Redis[] = [];
  const stores: Store[] = [];
  const create = () => {
    if (!endpoint) return memoryStore();
    const client = new Redis(endpoint.url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      commandTimeout: 10000,
    });
    connections.push(client);
    return redisStore({ client, prefix: options.prefix });
  };
  const results = [];
  const contention = [];
  const iterations = options.iterations;
  const summarize = (samples: number[], evaluated: number, granted: number) => {
    const elapsedMs = samples.reduce((a, b) => a + b, 0);
    const sorted = [...samples].sort((a, b) => a - b);
    return {
      evaluated,
      granted,
      elapsedMs,
      evaluationsPerSecond: (evaluated / elapsedMs) * 1000,
      usefulGrantsPerSecond: (granted / elapsedMs) * 1000,
      medianMs: sorted[Math.floor(sorted.length / 2)]!,
      p99Ms:
        sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))]!,
    };
  };
  try {
    const store = create();
    stores.push(store);
    if (!store.acquireScoped)
      throw new Error('Measured build has no scoped Store contract');
    for (const batch of [1, 32, 128])
      for (const ruleCount of [2, 8, 16])
        for (const workload of ['cold', 'hot', 'mixed']) {
          const id = `${options.store}-${batch}-${ruleCount}-${workload}`;
          const rules = scopedRules(ruleCount);
          const samples: number[] = [];
          let granted = 0,
            keys = 0;
          for (let i = 0; i < iterations; i++) {
            const jobs = Array.from({ length: batch }, (_, j) => ({
              cost: 1,
              scopes: {
                recipient:
                  workload === 'hot' ||
                  (workload === 'mixed' && (i * batch + j) % 2 === 0)
                    ? 'hot'
                    : `cold-${i}-${j}`,
              },
            }));
            // Declared logical cardinality; no imports of Valve's private key preparation code.
            keys +=
              1 +
              new Set(jobs.map((j) => j.scopes.recipient)).size *
                (ruleCount - 1);
            const request: ScopedAcquireRequest = { id, rules, jobs };
            const start = performance.now();
            const result = await store.acquireScoped(request);
            samples.push(performance.now() - start);
            granted += result.grantedIndexes.length;
          }
          const expected = expectedGrants(batch * iterations, workload);
          if (granted !== expected)
            throw new Error(
              `${id}: expected ${expected} grants, received ${granted}`,
            );
          results.push({
            batch,
            ruleCount,
            workload,
            iterations,
            logicalKeysPerCall: keys / iterations,
            ...summarize(samples, batch * iterations, granted),
          });
        }
    if (endpoint)
      for (const workers of [1, 4, 8]) {
        const peers = Array.from({ length: workers }, create);
        stores.push(...peers);
        const rules = scopedRules(2),
          samples: number[] = [];
        let granted = 0;
        const began = performance.now();
        await Promise.all(
          peers.map(async (peer, worker) => {
            for (let i = 0; i < iterations; i++) {
              const request = {
                id: `contended-${workers}`,
                rules,
                jobs: Array.from({ length: 32 }, (_, j) => ({
                  cost: 1,
                  scopes: { recipient: j % 2 ? `${worker}-${i}-${j}` : 'hot' },
                })),
              };
              const start = performance.now();
              const result = await peer.acquireScoped!(request);
              samples.push(performance.now() - start);
              granted += result.grantedIndexes.length;
            }
          }),
        );
        const elapsedMs = performance.now() - began;
        const expected = workers * iterations * 16 + 1;
        if (granted !== expected)
          throw new Error(
            `contention/${workers}: expected ${expected} grants, received ${granted}`,
          );
        contention.push({
          workers,
          batch: 32,
          iterations,
          ...summarize(samples, workers * iterations * 32, granted),
          // Overlapping client latencies are not summed when calculating contention throughput.
          elapsedMs,
          evaluationsPerSecond:
            ((workers * iterations * 32) / elapsedMs) * 1000,
          usefulGrantsPerSecond: (granted / elapsedMs) * 1000,
        });
      }
  } finally {
    await Promise.allSettled(stores.map((s) => s.close()));
    try {
      if (connections[0])
        await cleanupPrefix(connections[0], `${options.prefix}:`);
    } finally {
      await Promise.allSettled(connections.map((c) => c.quit()));
    }
  }
  return { store: options.store, results, contention };
}
