import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pLimit from 'p-limit';
import type { CellSpec } from '../core/types.ts';
import type { Adapter } from './types.ts';

const require = createRequire(import.meta.url);
export function concurrencyOf(cell: CellSpec): number | undefined {
  return typeof cell.concurrency === 'number'
    ? cell.concurrency
    : cell.concurrency?.limit;
}
export function commonGap(cell: CellSpec): string | undefined {
  if ((cell.apiMode && cell.apiMode !== 'run') || cell.controls?.length)
    return 'Valve public wrapper/feedback/pause suite; no equivalent comparator contract';
  if (
    cell.category === 'V-only' ||
    ['scoped', 'multi-rule', 'weighted', 'combined'].includes(cell.mechanism) ||
    (cell.mechanism === 'lease' && cell.category !== 'D1')
  )
    return 'Valve-only atomic/scoped/lease/shared-pause semantics';
  if ((cell.rules?.length ?? 0) > 1)
    return 'Multiple atomic rules are unsupported';
  if (
    cell.rules?.some((rule) => rule.scope) ||
    cell.workload.job.scopes?.length
  )
    return 'Scoped quotas are unsupported';
  if (cell.rules?.length && cell.concurrency !== undefined)
    return 'Rate plus concurrency/lease is a Valve-only comparison';
  if (cell.workload.deadlines)
    return 'maxWait is queue wait, not an execution timeout or running cancellation';
  if (cell.maxQueue !== undefined)
    return 'Queue capacity/rejection semantics differ';
  if (cell.faults?.length) return 'Fault recovery semantics are not comparable';
  return undefined;
}
export function weighted(cell: CellSpec): boolean {
  return cell.workload.job.costs?.values.some((cost) => cost !== 1) ?? false;
}
export const plimitAdapter: Adapter = {
  id: 'p-limit',
  version: (
    JSON.parse(
      readFileSync(
        new URL('./package.json', pathToFileURL(require.resolve('p-limit'))),
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
      return 'Local concurrency only; no distributed coordination';
    if (
      cell.rules?.length ||
      (cell.category !== undefined && cell.category !== 'L1') ||
      cell.mechanism !== 'local-concurrency'
    )
      return 'L1 only; no rate, window, or burst contract';
    if (cell.workload.abort) return 'No queued AbortSignal cancellation';
    if (weighted(cell)) return 'No weighted rate cost';
    if (!concurrencyOf(cell)) return 'L1 requires a concurrency limit';
    return true;
  },
  async create(ctx) {
    // Installed p-limit/index.js:3-10,19-29: pLimit(C), slots freed on settlement.
    const limit = pLimit(concurrencyOf(ctx.cell)!);
    return {
      submit(fn) {
        return limit(fn);
      },
      // index.js:77-88: clearQueue discards queued callbacks (no cancellation claim).
      async close() {
        limit.clearQueue();
      },
      stats: () => ({ active: limit.activeCount, queued: limit.pendingCount }),
    };
  },
};
