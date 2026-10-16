// A synchronous memory budget with lazy expiry and bounded periodic sweeping.
import { prepareScoped } from './scoped.js';
import { ruleFingerprint } from './rules.js';
import { failure } from './errors.js';
import { acquireBatch } from './algorithms.js';
import type { RuleState } from './algorithms.js';
import type {
  AcquireRequest,
  AcquireResult,
  Store,
  StoreNotification,
  ScopedAcquireRequest,
  ScopedAcquireResult,
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
  const scopedStates = new Map<string, Map<string, RuleState>>();
  const policies = new Map<string, string>();
  // Static policy fingerprints, pruned with the id's rate, lease, and pause state.
  const staticIds = new Map<string, string>();
  const fingerprints = new WeakMap<AcquireRequest['rules'], string>();
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
  /** Admit a static prefix, retaining policy ownership even during a pause. */
  function acquireSync(request: AcquireRequest) {
    if (policies.has(request.id))
      throw failure(
        request.id,
        'INVALID_OPTIONS',
        'Cannot mix static and scoped policies under one Valve id.',
      );
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
      for (const id of staticIds.keys())
        if (!states.has(id) && !leases.has(id) && !pauses.has(id))
          staticIds.delete(id);
    }
    let rules = fingerprints.get(request.rules);
    if (rules === undefined) {
      rules = ruleFingerprint(request.rules);
      fingerprints.set(request.rules, rules);
    }
    const policy = `${rules}:${request.lease ? `${request.lease.limit}:${request.lease.ttlMs}` : 'local'}`;
    const owned = staticIds.get(request.id);
    if (owned !== undefined && owned !== policy)
      throw failure(
        request.id,
        'INVALID_OPTIONS',
        'Shared quota configuration does not match. Use identical rate and global concurrency settings for every valve that shares this id.',
      );
    staticIds.set(request.id, policy);
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
      // Slots granted by this call are added below, so the set can still be empty.
      if (capacity < request.costs.length)
        leaseRetry = Math.max(
          1,
          Math.ceil(
            (slots.size
              ? Math.min(...slots.values())
              : now + request.lease.ttlMs) - now,
          ),
        );
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
  /** Iterate all domains so each admission can sweep a bounded amount of expired state. */
  function* scopedEntries(): Generator<
    [string, Map<string, RuleState>, string]
  > {
    for (const [domain, entries] of scopedStates)
      for (const key of entries.keys()) yield [domain, entries, key];
  }
  let sweep: ReturnType<typeof scopedEntries> | undefined;
  /** Commit each job only when all its budgets and any global lease allow admission. */
  function acquireScopedSync(
    request: ScopedAcquireRequest,
  ): ScopedAcquireResult {
    const plan = prepareScoped(request);
    if (staticIds.has(request.id))
      throw failure(
        request.id,
        'INVALID_OPTIONS',
        'Cannot mix static and scoped policies under one Valve id.',
      );
    const policy = policies.get(request.id);
    if (policy && policy !== plan.fingerprint)
      throw failure(
        request.id,
        'INVALID_OPTIONS',
        'Shared scoped quota configuration does not match. Drain workers before changing policies.',
      );
    const now = clock();
    const entries =
      scopedStates.get(request.id) ?? new Map<string, RuleState>();
    const current = plan.keys.map((key) => {
      const state = entries.get(key);
      return state && state.expires > now
        ? { ...state }
        : { a: 0, b: 0, expires: 0 };
    });
    const slots = leases.get(request.id) ?? new Map<string, number>();
    for (const [token, expiry] of slots) if (expiry <= now) slots.delete(token);
    const grantedIndexes: number[] = [];
    const blocked: { index: number; retryAfterMs: number }[] = [];
    const tokens: { index: number; token: string }[] = [];
    const pause = Math.max(0, Math.ceil((pauses.get(request.id) ?? 0) - now));
    for (let index = 0; index < plan.jobs.length; index++) {
      const job = plan.jobs[index]!;
      let retry = pause;
      if (request.lease && slots.size >= request.lease.limit) {
        let earliest = Infinity;
        for (const expiry of slots.values())
          earliest = Math.min(earliest, expiry);
        retry = Math.max(retry, Math.ceil(earliest - now), 1);
      }
      {
        const result = acquireBatch(
          job.refs.map((i) => plan.rules[i]!),
          [job.cost],
          job.refs.map((i) => (retry ? { ...current[i]! } : current[i]!)),
          now,
        );
        retry = Math.max(retry, result.retryAfterMs);
      }
      if (retry) blocked.push({ index, retryAfterMs: retry });
      else {
        grantedIndexes.push(index);
        for (const i of job.refs) entries.set(plan.keys[i]!, current[i]!);
        if (request.lease) {
          const token = `${request.lease.owner}:${index}`;
          slots.set(token, now + request.lease.ttlMs);
          tokens.push({ index, token });
        }
      }
    }
    policies.set(request.id, plan.fingerprint);
    if (entries.size) scopedStates.set(request.id, entries);
    if (slots.size) leases.set(request.id, slots);
    else leases.delete(request.id);
    // Sweep a bounded number across all quota domains, including inactive ones.
    {
      sweep ??= scopedEntries();
      for (
        let visited = 0;
        visited < Math.max(32, plan.keys.length * 2);
        visited++
      ) {
        const next = sweep.next();
        if (next.done) {
          sweep = undefined;
          break;
        }
        const [domain, entries, key] = next.value;
        if ((entries.get(key)?.expires ?? 0) <= now) entries.delete(key);
        if (!entries.size) {
          scopedStates.delete(domain);
          if (!leases.has(domain) && !pauses.has(domain))
            policies.delete(domain);
        }
      }
    }
    return {
      grantedIndexes,
      blocked,
      ...(pause ? { pausedMs: pause } : {}),
      ...(request.lease ? { leases: tokens } : {}),
    };
  }
  return {
    kind: 'memory',
    acquireScopedSync,
    acquireScoped: (request) => Promise.resolve(acquireScopedSync(request)),
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
      staticIds.clear();
      policies.clear();
      scopedStates.clear();
      sweep = undefined;
      pauses.clear();
      leases.clear();
      listeners.clear();
      return Promise.resolve();
    },
  };
}
