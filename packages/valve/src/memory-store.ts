// A synchronous memory budget with lazy expiry and bounded periodic sweeping.
import { acquireBatch } from './algorithms.js';
import type { RuleState } from './algorithms.js';
import type { AcquireRequest, Store } from './store.js';
/** Options for the memory store. @example memoryStore({ clock: () => now }); */
export interface MemoryStoreOptions {
  /** Epoch milliseconds. Defaults to Date.now. */ clock?: () => number;
}
/** Create an in-process store. Reuse its instance to share budgets by id.
 * @param options Optional clock for deterministic tests.
 * @returns A store with a synchronous acquire fast path.
 * @example const store = memoryStore(); const api = createValve({ id: 'api', concurrency: 2, store });
 */
export function memoryStore(options: MemoryStoreOptions = {}): Store {
  const clock = options.clock ?? Date.now;
  const states = new Map<string, Map<string, RuleState>>();
  const pauses = new Map<string, number>();
  let acquires = 0;
  function acquireSync(request: AcquireRequest) {
    const now = clock();
    if (++acquires % 1024 === 0) {
      for (const [id, entries] of states) {
        for (const [key, state] of entries)
          if (state.expires <= now) entries.delete(key);
        if (!entries.size) states.delete(id);
      }
      for (const [id, end] of pauses) if (end <= now) pauses.delete(id);
    }
    const end = pauses.get(request.id) ?? 0;
    if (end > now)
      return {
        granted: 0,
        retryAfterMs: Math.ceil(end - now),
        pausedMs: Math.ceil(end - now),
      };
    pauses.delete(request.id);
    const entries = states.get(request.id) ?? new Map<string, RuleState>();
    const current = request.rules.map((rule) => {
      const state = entries.get(rule.key);
      return state && state.expires > now
        ? { ...state }
        : { a: 0, b: 0, expires: 0 };
    });
    const result = acquireBatch(request.rules, request.costs, current, now);
    if (result.granted) {
      request.rules.forEach((rule, i) => entries.set(rule.key, current[i]!));
      states.set(request.id, entries);
    }
    return result;
  }
  return {
    kind: 'memory',
    acquireSync,
    acquire: (request) => Promise.resolve(acquireSync(request)),
    pause: (id, ms) => {
      pauses.set(id, Math.max(pauses.get(id) ?? 0, clock() + ms));
      return Promise.resolve();
    },
    resume: (id) => {
      pauses.delete(id);
      return Promise.resolve();
    },
    close: () => {
      states.clear();
      pauses.clear();
      return Promise.resolve();
    },
  };
}
