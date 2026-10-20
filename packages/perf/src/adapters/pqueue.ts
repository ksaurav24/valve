import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import PQueue from 'p-queue';
import type { Adapter } from './types.ts';
import { commonGap, concurrencyOf, weighted } from './plimit.ts';
const require = createRequire(import.meta.url);
export const pqueueAdapter: Adapter = {
  id: 'p-queue',
  version: (
    JSON.parse(
      readFileSync(
        new URL('../package.json', pathToFileURL(require.resolve('p-queue'))),
        'utf8',
      ),
    ) as { version: string }
  ).version,
  supports(cell) {
    const gap = commonGap(cell);
    if (gap) return gap;
    if (
      cell.store.kind !== 'memory' ||
      (typeof cell.concurrency === 'object' &&
        cell.concurrency.scope === 'global')
    )
      return 'Local only; no distributed coordination';
    if (weighted(cell)) return 'No weighted rate cost';
    if (
      cell.category === 'L4' ||
      cell.mechanism === 'burst-bank' ||
      cell.rules?.some((r) => (r.burst ?? 1) > 1)
    )
      return 'Rolling count is not a GCRA burst bank';
    if (cell.category && !['L1', 'L2', 'L3', 'L5'].includes(cell.category))
      return 'Only L1, L2, L3, L5 are comparable';
    if (
      cell.rules?.length &&
      !['pacing', 'gcra', 'window', 'fixed-window'].includes(cell.mechanism)
    )
      return 'Unsupported rate mechanism';
    if (!cell.rules?.length && !concurrencyOf(cell))
      return 'Requires a rate rule or concurrency limit';
    return true;
  },
  async create(ctx) {
    const cell = ctx.cell;
    const rule = cell.rules?.[0];
    // Installed p-queue/dist/index.js:57-85. Do NOT use masked carryoverConcurrencyCount.
    const queue = new PQueue({
      ...(concurrencyOf(cell) === undefined
        ? {}
        : { concurrency: concurrencyOf(cell)! }),
      ...(rule
        ? rule.algorithm === 'fixed-window' || cell.category === 'L3'
          ? {
              interval: rule.intervalMs,
              intervalCap: rule.limit,
              carryoverIntervalCount: false,
            }
          : {
              interval: rule.intervalMs / rule.limit,
              intervalCap: 1,
              strict: true,
            }
        : {}),
    });
    return {
      async submit(fn, options) {
        try {
          // dist/index.js:373-411,430-447: signal removes queued jobs; also races running jobs.
          // dist/priority-queue.js:22-30: higher priorities first, same as Valve.
          return (await queue.add(fn, {
            ...(options.priority === undefined
              ? {}
              : { priority: options.priority }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          })) as Awaited<ReturnType<typeof fn>>;
        } catch (error) {
          if (options.signal?.aborted)
            throw Object.assign(new Error('Aborted', { cause: error }), {
              code: 'ABORTED',
            });
          throw error;
        }
      },
      // dist/index.js:471-497: pause + clear releases queued listeners; strict timeout
      // can remain until an already-running callback settles (484-494).
      async close() {
        queue.pause();
        queue.clear();
      },
      stats: () => ({ active: queue.pending, queued: queue.size }),
    };
  },
};
