import type { CellSpec, LibraryId, Mechanism } from '../core/types.ts';
import type { Adapter } from './types.ts';
import { identityAdapter } from './identity.ts';
import { plimitAdapter } from './plimit.ts';
import { pqueueAdapter } from './pqueue.ts';
import { bottleneckAdapter } from './bottleneck.ts';

export const competitorAdapters: Adapter[] = [
  identityAdapter,
  plimitAdapter,
  pqueueAdapter,
  bottleneckAdapter,
];
const adapters = new Map(
  competitorAdapters.map((adapter) => [adapter.id, adapter]),
);
/** Register a limiter implementation under its declared library identity. */
export function registerAdapter(adapter: Adapter): void {
  adapters.set(adapter.id, adapter);
}
/** Resolve a library adapter or reject an unsupported library identity. */
export function adapterFor(id: LibraryId): Adapter {
  const adapter = adapters.get(id);
  if (!adapter) throw new Error(`Adapter not registered: ${id}`);
  return adapter;
}
export interface Category {
  id: string;
  title: string;
  contract: string;
  control: LibraryId | null;
  mechanism: Mechanism;
  locality: 'local' | 'distributed';
  buildCell(base?: Partial<CellSpec>): CellSpec;
}
function category(
  id: string,
  title: string,
  contract: string,
  control: LibraryId | null,
  mechanism: Mechanism,
  distributed = false,
): Category {
  return {
    id,
    title,
    contract,
    control,
    mechanism,
    locality: distributed ? 'distributed' : 'local',
    buildCell(base = {}) {
      const concurrency = ['L1', 'L5', 'D1'].includes(id);
      return {
        id: `comparison/${id}`,
        suite: 'comparison',
        category: id,
        library: control ?? 'valve',
        mechanism,
        workers: distributed ? 2 : 1,
        store: distributed
          ? { kind: 'redis', server: 'redis74' }
          : { kind: 'memory' },
        ...(concurrency
          ? {
              concurrency: distributed
                ? { limit: 2, scope: 'global' as const }
                : 2,
            }
          : {}),
        ...(!concurrency && id !== 'V-only'
          ? {
              rules: [
                {
                  limit: 2,
                  intervalMs: 1000,
                  ...(id === 'L4' ? { burst: 4 } : { burst: 1 }),
                  algorithm: ['L3', 'D3'].includes(id)
                    ? ('fixed-window' as const)
                    : ('gcra' as const),
                },
              ],
            }
          : {}),
        workload: {
          arrival: { kind: 'backlog', depth: 8 },
          job: { kind: 'async', duration: { kind: 'fixed', ms: 10 } },
          ...(id === 'L5'
            ? {
                abort: {
                  fraction: 0.5,
                  after: { kind: 'fixed' as const, ms: 1 },
                },
              }
            : {}),
        },
        timing: { warmupMs: 0, windowMs: 2000, drainMs: 5000 },
        priority: 0,
        tags: [],
        ...(id === 'L4'
          ? {
              notes: [
                'Bottleneck approximate: integral periodic refill capped at B; not GCRA',
              ],
            }
          : {}),
        ...base,
      };
    },
  };
}
export const CATEGORIES: Category[] = [
  category(
    'L1',
    'Local concurrency',
    'At most C callbacks running locally',
    'p-limit',
    'local-concurrency',
  ),
  category(
    'L2',
    'Local burst-1 pacing',
    'Starts separated by at least I/R (timer tolerance applies)',
    'bottleneck',
    'pacing',
  ),
  category(
    'L3',
    'Local fixed-window quota',
    'At most R starts per library-anchored window; anchors differ',
    'p-queue',
    'window',
  ),
  category(
    'L4',
    'Local burst bank',
    'GCRA at most R+B−1 per I with burst B; Bottleneck uses approximate integral capped refill',
    'bottleneck',
    'burst-bank',
  ),
  category(
    'L5',
    'Queued cancellation',
    'Aborted queued callbacks never start; running cancellation is not compared',
    'p-queue',
    'cancellation',
  ),
  category(
    'D1',
    'Global concurrency',
    'At most C running across instances/processes',
    'bottleneck',
    'lease',
    true,
  ),
  category(
    'D2',
    'Global burst-1 pacing',
    'Global start spacing I/R (timer tolerance applies)',
    'bottleneck',
    'pacing',
    true,
  ),
  category(
    'D3',
    'Global window',
    'At most R starts per shared library-anchored reservoir window',
    'bottleneck',
    'window',
    true,
  ),
  category(
    'V-only',
    'Valve atomic features',
    'Scoped, multi-rule atomic, weighted atomic, rate+lease, shared pause',
    null,
    'combined',
  ),
];
export type MatrixStatus =
  'supported' | { na: string } | { approximate: string };
/** Describe category support and explicit incompatibilities for every registered adapter. */
export function naMatrix(): Record<
  string,
  Partial<Record<LibraryId, MatrixStatus>>
> {
  return Object.fromEntries(
    CATEGORIES.map((category) => [
      category.id,
      Object.fromEntries(
        [...adapters.values()].map((adapter) => {
          // Identity remains a separate harness-floor row even for Valve-only workloads.
          const support = adapter.supports(
            category.buildCell({ library: adapter.id }),
          );
          const status: MatrixStatus =
            category.id === 'V-only' && adapter.id !== 'valve'
              ? {
                  na: 'Valve-only semantics; identity is only the separate harness floor',
                }
              : support !== true
                ? { na: support }
                : category.id === 'L4' && adapter.id === 'bottleneck'
                  ? {
                      approximate:
                        'Integral periodic reservoir refill, capped at B, is not GCRA',
                    }
                  : 'supported';
          return [adapter.id, status];
        }),
      ),
    ]),
  );
}
