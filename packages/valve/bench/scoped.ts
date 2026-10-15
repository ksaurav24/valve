// Admission-only workload matrix. Denials count as evaluations, never throughput.
import { writeFileSync } from 'node:fs';
import { Redis } from 'ioredis5';
import { memoryStore } from '../src/index.js';
import { redisStore } from '../src/redis/index.js';
import { normalize } from '../src/rules.js';
import { prepareScoped } from '../src/scoped.js';
import type { RateRule } from '../src/types.js';
const client = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL)
  : undefined;
const prefix = `scoped-bench-${Date.now()}`;
const stores = [
  memoryStore(),
  ...(client ? [redisStore({ client, prefix })] : []),
];
const results = [];
const contention = [];
const iterations = Number(process.env.SCOPED_BENCH_ITERATIONS ?? 100);
try {
  for (const store of stores)
    for (const batch of [1, 32, 128])
      for (const ruleCount of [2, 8, 16])
        for (const workload of ['cold', 'hot', 'mixed'] as const) {
          const id = `${store.kind}-${batch}-${ruleCount}-${workload}`;
          const rate: RateRule[] = [
            {
              name: 'shared',
              limit: 1000000000,
              interval: '24h',
              algorithm: 'fixed-window',
            },
          ];
          for (let r = 1; r < ruleCount; r++)
            rate.push({
              name: `r${r}`,
              scope: 'recipient',
              limit: 1,
              interval: '24h',
            });
          const rules = normalize({ id, rate }).rules;
          let granted = 0;
          let uniqueKeys = 0;
          const samples: number[] = [];
          for (let i = 0; i < iterations; i++) {
            const jobs = Array.from({ length: batch }, (_, j) => ({
              cost: 1,
              scopes: {
                recipient:
                  workload === 'hot' || (workload === 'mixed' && j % 2 === 0)
                    ? 'hot'
                    : `cold-${i}-${j}`,
              },
            }));
            const request = { id, rules, jobs };
            uniqueKeys += prepareScoped(request).keys.length;
            const start = performance.now();
            const result = await store.acquireScoped!(request);
            samples.push(performance.now() - start);
            granted += result.grantedIndexes.length;
          }
          const elapsed = samples.reduce((a, b) => a + b, 0);
          samples.sort((a, b) => a - b);
          const result = {
            store: store.kind,
            batch,
            ruleCount,
            workload,
            iterations,
            evaluated: batch * iterations,
            granted,
            keysPerCall: uniqueKeys / iterations,
            evaluationsPerSecond: ((batch * iterations) / elapsed) * 1000,
            medianMs: samples[Math.floor(samples.length / 2)],
            p99Ms: samples[Math.floor(samples.length * 0.99)],
          };
          results.push(result);
          console.log(JSON.stringify(result));
        }
  if (client) {
    for (const workers of [1, 4, 8]) {
      const clients = Array.from(
        { length: workers },
        () => new Redis(process.env.REDIS_URL!),
      );
      const peers = clients.map((client) => redisStore({ client, prefix }));
      const id = `contended-${workers}`;
      const rules = normalize({
        id,
        rate: [
          {
            name: 'all',
            limit: 1000000000,
            interval: '24h',
            algorithm: 'fixed-window',
          },
          { name: 'r', scope: 'recipient', limit: 1, interval: '24h' },
        ],
      }).rules;
      let granted = 0;
      const latencies: number[] = [];
      const start = performance.now();
      try {
        await Promise.all(
          peers.map(async (peer, worker) => {
            for (let i = 0; i < iterations; i++) {
              const begin = performance.now();
              const result = await peer.acquireScoped!({
                id,
                rules,
                jobs: Array.from({ length: 32 }, (_, j) => ({
                  cost: 1,
                  scopes: { recipient: j % 2 ? `${worker}-${i}-${j}` : 'hot' },
                })),
              });
              latencies.push(performance.now() - begin);
              granted += result.grantedIndexes.length;
            }
          }),
        );
        const elapsedMs = performance.now() - start;
        latencies.sort((a, b) => a - b);
        const result = {
          workers,
          batch: 32,
          iterations,
          granted,
          evaluationsPerSecond:
            ((workers * iterations * 32) / elapsedMs) * 1000,
          medianMs: latencies[Math.floor(latencies.length / 2)],
          p99Ms: latencies[Math.floor(latencies.length * 0.99)],
        };
        contention.push(result);
        console.log(JSON.stringify({ contention: result }));
      } finally {
        for (const peer of peers) await peer.close();
        for (const connection of clients) await connection.quit();
      }
    }
  }
} finally {
  for (const store of stores) await store.close();
  if (client) {
    let cursor = '0';
    do {
      const [next, keys] = await client.scan(
        cursor,
        'MATCH',
        `${prefix}:*`,
        'COUNT',
        1000,
      );
      cursor = next;
      if (keys.length) await client.unlink(...keys);
    } while (cursor !== '0');
    await client.quit();
  }
}
if (process.env.SCOPED_BENCH_OUT)
  writeFileSync(
    process.env.SCOPED_BENCH_OUT,
    JSON.stringify({ node: process.version, results, contention }, null, 2),
  );
