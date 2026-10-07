// A synchronous memory budget with lazy expiry and bounded periodic sweeping.
import { acquireBatch } from './algorithms.js';
import type { RuleState } from './algorithms.js';
import type {
  AcquireRequest,
  AcquireResult,
  Store,
  StoreNotification,
} from './store.js';
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
  const leases = new Map<string, Map<string, number>>();
  const listeners = new Map<string, Set<(notice: StoreNotification) => void>>();
  function notify(id: string, notice: StoreNotification) {
    for (const listener of listeners.get(id) ?? [])
      queueMicrotask(() => {
        if (listeners.get(id)?.has(listener)) listener(notice);
      });
  }
  let acquires = 0;
  function acquireSync(request: AcquireRequest) {
    const now = clock();
    if (++acquires % 1024 === 0) {
      for (const [id, entries] of states) {
        for (const [key, state] of entries)
          if (state.expires <= now) entries.delete(key);
        if (!entries.size) states.delete(id);
      }
      for (const [id, slots] of leases) {
        for (const [token, expiry] of slots)
          if (expiry <= now) slots.delete(token);
        if (!slots.size) leases.delete(id);
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
    let returnResult: AcquireResult | undefined;
    let slots: Map<string, number> | undefined;
    let capacity = request.costs.length;
    let leaseRetry = 0;
    if (request.lease) {
      slots = leases.get(request.id) ?? new Map();
      for (const [token, expiry] of slots)
        if (expiry <= now) slots.delete(token);
      capacity = Math.max(
        0,
        Math.min(capacity, request.lease.limit - slots.size),
      );
      if (capacity < request.costs.length)
        leaseRetry = Math.max(1, Math.ceil(Math.min(...slots.values()) - now));
    }
    const result = acquireBatch(
      request.rules,
      request.lease ? request.costs.slice(0, capacity) : request.costs,
      current,
      now,
    );
    if (slots && request.lease) {
      const granted = Array.from(
        { length: result.granted },
        (_, i) => `${request.lease!.owner}:${i}`,
      );
      for (const token of granted) slots.set(token, now + request.lease.ttlMs);
      if (slots.size) leases.set(request.id, slots);
      else leases.delete(request.id);
      returnResult = {
        ...result,
        leases: granted,
        retryAfterMs:
          result.granted === capacity && capacity < request.costs.length
            ? leaseRetry
            : result.retryAfterMs,
      };
    }
    if (result.granted) {
      request.rules.forEach((rule, i) => entries.set(rule.key, current[i]!));
      states.set(request.id, entries);
    }
    return returnResult ?? result;
  }
  return {
    kind: 'memory',
    acquireSync,
    acquire: (request) => Promise.resolve(acquireSync(request)),
    pause: (id, ms) => {
      pauses.set(id, Math.max(pauses.get(id) ?? 0, clock() + ms));
      notify(id, {
        type: 'pause',
        durationMs: Math.max(0, pauses.get(id)! - clock()),
      });
      return Promise.resolve();
    },
    resume: (id) => {
      pauses.delete(id);
      notify(id, { type: 'resume' });
      return Promise.resolve();
    },
    release: (id, tokens) => {
      const slots = leases.get(id);
      for (const token of tokens) slots?.delete(token);
      if (!slots?.size) leases.delete(id);
      notify(id, { type: 'release' });
      return Promise.resolve();
    },
    renew: (id, tokens, ttlMs) => {
      const now = clock();
      const slots = leases.get(id);
      let valid = true;
      for (const token of tokens) {
        if ((slots?.get(token) ?? 0) <= now) {
          slots?.delete(token);
          valid = false;
        } else slots!.set(token, now + ttlMs);
      }
      return Promise.resolve(valid);
    },
    subscribe: (id, listener) => {
      const entries = listeners.get(id) ?? new Set();
      entries.add(listener);
      listeners.set(id, entries);
      return () => {
        entries.delete(listener);
        if (!entries.size) listeners.delete(id);
      };
    },
    close: () => {
      states.clear();
      pauses.clear();
      leases.clear();
      listeners.clear();
      return Promise.resolve();
    },
  };
}
