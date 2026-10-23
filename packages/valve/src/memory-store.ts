// A synchronous memory budget with lazy expiry and bounded periodic sweeping.
import { prepareScoped } from './scoped.js';
import { ruleFingerprint } from './rules.js';
import { failure } from './errors.js';
import { acquireBatch } from './algorithms.js';
import type { RuleState } from './algorithms.js';
import {
  applyPatch,
  checkPatch,
  expiry,
  managedBatch,
  marker,
  pin,
  precise,
  register,
  snapshot,
  theta,
} from './managed.js';
import type { FrameRule } from './managed.js';
import type {
  AcquireRequest,
  AcquireResult,
  ManagedAcquireRequest,
  ManagedAcquireResult,
  ManagedContext,
  ManagedScopedRequest,
  ManagedScopedResult,
  ManagedUpdateRequest,
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
  // Managed limits by id. Like Redis, they persist until close without expiry.
  const managed = new Map<
    string,
    {
      epoch: number;
      revision: number;
      updated: boolean;
      structure: string;
      pin: string;
      rules: Map<string, FrameRule>;
    }
  >();
  let lastEpoch = 0;
  /** Deliver a shared-state hint asynchronously to listeners still subscribed. */
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
    prune(now);
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
        managed.has(request.id)
          ? 'This id uses managed limits. Set limits: "managed" with the same rule names, scopes, algorithms and intervals.'
          : 'Shared quota configuration does not match. Use identical rate and global concurrency settings for every valve that shares this id.',
      );
    staticIds.set(request.id, policy);
    return admit(request, now, (current, costs) =>
      acquireBatch(request.rules, costs, current, now),
    );
  }
  /** Periodically drop expired static state, leases, pauses, and unused static pins. */
  function prune(now: number) {
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
        if (
          !states.has(id) &&
          !leases.has(id) &&
          !pauses.has(id) &&
          !managed.has(id)
        )
          staticIds.delete(id);
    }
  }
  /** Check the pause, then grant a prefix with leases using the supplied rate math. */
  function admit<R extends AcquireResult>(
    request: AcquireRequest,
    now: number,
    batch: (current: RuleState[], costs: readonly number[]) => R,
  ): R | AcquireResult {
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
    let returnResult: R | undefined;
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
    const result = batch(
      current,
      request.lease ? request.costs.slice(0, capacity) : request.costs,
    );
    if (slots && request.lease) {
      const granted = Array.from(
        { length: result.granted },
        (_, i) => `${request.lease!.owner}:${i}`,
      );
      for (const token of granted) slots.set(token, now + request.lease.ttlMs);
      if (slots.size) leases.set(request.id, slots);
      else leases.delete(request.id);
      const leaseBlocked =
        result.granted === capacity && capacity < request.costs.length;
      returnResult = {
        ...result,
        leases: granted,
        retryAfterMs: leaseBlocked ? leaseRetry : result.retryAfterMs,
        leaseBlocked,
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
    const blocked: {
      index: number;
      retryAfterMs: number;
      leaseBlocked?: boolean;
    }[] = [];
    const tokens: { index: number; token: string }[] = [];
    const pause = Math.max(0, Math.ceil((pauses.get(request.id) ?? 0) - now));
    for (let index = 0; index < plan.jobs.length; index++) {
      const job = plan.jobs[index]!;
      let leaseRetry = 0;
      if (request.lease && slots.size >= request.lease.limit) {
        let earliest = Infinity;
        for (const expiry of slots.values())
          earliest = Math.min(earliest, expiry);
        leaseRetry = Math.max(Math.ceil(earliest - now), 1);
      }
      let retry = Math.max(pause, leaseRetry);
      {
        const result = acquireBatch(
          job.refs.map((i) => plan.rules[i]!),
          [job.cost],
          job.refs.map((i) => (retry ? { ...current[i]! } : current[i]!)),
          now,
        );
        retry = Math.max(retry, result.retryAfterMs);
      }
      if (retry)
        blocked.push({
          index,
          retryAfterMs: retry,
          ...(request.lease ? { leaseBlocked: retry === leaseRetry } : {}),
        });
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
    sweepScoped(plan.keys.length, now);
    return {
      grantedIndexes,
      blocked,
      ...(pause ? { pausedMs: pause } : {}),
      ...(request.lease ? { leases: tokens } : {}),
    };
  }
  /** Sweep a bounded number across quota domains, including inactive ones. */
  function sweepScoped(keyCount: number, now: number) {
    sweep ??= scopedEntries();
    for (let visited = 0; visited < Math.max(32, keyCount * 2); visited++) {
      const next = sweep.next();
      if (next.done) {
        sweep = undefined;
        break;
      }
      const [domain, entries, key] = next.value;
      if ((entries.get(key)?.expires ?? 0) <= now) entries.delete(key);
      if (!entries.size) {
        scopedStates.delete(domain);
        if (!leases.has(domain) && !pauses.has(domain) && !managed.has(domain))
          policies.delete(domain);
      }
    }
  }
  /**
   * Resolve the managed limits for a request, registering, adopting, or restoring
   * its pin, and reject structural or immutable conflicts before any write.
   */
  function resolve(
    context: ManagedContext,
    scoped: boolean,
    now: number,
    commit = true,
  ) {
    const id = context.id;
    const own = scoped ? policies : staticIds;
    if ((scoped ? staticIds : policies).has(id))
      throw failure(
        id,
        'INVALID_OPTIONS',
        'Cannot mix static and scoped policies under one Valve id.',
      );
    const mark = marker(context);
    const mismatch = () =>
      failure(
        id,
        'INVALID_OPTIONS',
        'Shared managed limits do not match this structure. Use the same rule names, scopes, algorithms, intervals, and global concurrency on every worker.',
      );
    const current = own.get(id);
    let state = managed.get(id);
    if (state) {
      if (
        state.structure !== mark ||
        (current !== undefined &&
          current !== mark &&
          !(current === state.pin && !state.updated))
      )
        throw mismatch();
    } else {
      const immutable = pin(context);
      if (current !== undefined && current !== mark && current !== immutable)
        throw mismatch();
      lastEpoch = Math.max(lastEpoch + 1, Math.floor(now * 1000));
      state = {
        epoch: lastEpoch,
        revision: 1,
        updated: current === mark,
        structure: mark,
        pin: immutable,
        rules: new Map(
          context.rules.map((rule) => [rule.name!, register(rule)]),
        ),
      };
    }
    if ([...state.rules.values()].some((frame) => !precise(frame, now)))
      throw failure(
        id,
        'INVALID_OPTIONS',
        'Managed GCRA limits exceed the safe numeric precision. Use a lower rate or a coordinated migration.',
      );
    if (commit) managed.set(id, state);
    if (commit && current === undefined)
      own.set(id, state.updated ? mark : state.pin);
    return state;
  }
  /** Combine the registration epoch and revision into an opaque version token. */
  function version(state: { epoch: number; revision: number }) {
    return `${state.epoch}.${state.revision}`;
  }
  /** Build a frozen snapshot using the caller's matching rule structure and order. */
  function limitsOf(
    state: NonNullable<ReturnType<typeof managed.get>>,
    context: ManagedContext,
  ) {
    return snapshot(version(state), state.revision, state.rules, context.rules);
  }
  /** Return the snapshot only when the caller's known version is stale. */
  function changed(
    state: NonNullable<ReturnType<typeof managed.get>>,
    context: ManagedContext,
  ) {
    return version(state) === context.known
      ? {}
      : { limits: limitsOf(state, context) };
  }
  /** Admit a static prefix using authoritative frames and return changed limits. */
  function managedAcquireSync(
    request: ManagedAcquireRequest,
  ): ManagedAcquireResult {
    const now = clock();
    prune(now);
    const state = resolve(request, false, now);
    const extra = changed(state, request);
    const rules = request.rules.map((rule) => state.rules.get(rule.name!)!);
    return {
      ...admit(request, now, (current, costs) =>
        managedBatch(rules, costs, current, now),
      ),
      ...extra,
    };
  }
  /** Admit scoped jobs atomically and retain live debt during rate-decrease expiry windows. */
  function managedScopedSync(
    request: ManagedScopedRequest,
  ): ManagedScopedResult {
    const plan = prepareScoped(request, true);
    const now = clock();
    const state = resolve(request, true, now);
    const frames = plan.rules.map((rule) => state.rules.get(rule.name!)!);
    const entries =
      scopedStates.get(request.id) ?? new Map<string, RuleState>();
    const current = plan.keys.map((key) => {
      const value = entries.get(key);
      return value && value.expires > now
        ? { ...value }
        : { a: 0, b: 0, expires: 0 };
    });
    const written = new Set<number>();
    const slots = leases.get(request.id) ?? new Map<string, number>();
    for (const [token, expiry] of slots) if (expiry <= now) slots.delete(token);
    const grantedIndexes: number[] = [];
    const blocked: {
      index: number;
      retryAfterMs: number;
      leaseBlocked?: boolean;
      impossible?: boolean;
    }[] = [];
    const tokens: { index: number; token: string }[] = [];
    const pause = Math.max(0, Math.ceil((pauses.get(request.id) ?? 0) - now));
    for (let index = 0; index < plan.jobs.length; index++) {
      const job = plan.jobs[index]!;
      let leaseRetry = 0;
      if (request.lease && slots.size >= request.lease.limit) {
        let earliest = Infinity;
        for (const expiry of slots.values())
          earliest = Math.min(earliest, expiry);
        leaseRetry = Math.max(Math.ceil(earliest - now), 1);
      }
      let retry = Math.max(pause, leaseRetry);
      const result = managedBatch(
        job.refs.map((i) => frames[i]!),
        [job.cost],
        job.refs.map((i) => (retry ? { ...current[i]! } : current[i]!)),
        now,
      );
      // A pause or full lease set answers first; capacity is judged once admissible.
      const impossible = !retry && result.impossible;
      retry = Math.max(retry, impossible ? 1 : result.retryAfterMs);
      if (retry)
        blocked.push({
          index,
          retryAfterMs: retry,
          ...(request.lease ? { leaseBlocked: retry === leaseRetry } : {}),
          ...(impossible ? { impossible } : {}),
        });
      else {
        grantedIndexes.push(index);
        for (const i of job.refs) {
          entries.set(plan.keys[i]!, current[i]!);
          written.add(i);
        }
        if (request.lease) {
          const token = `${request.lease.owner}:${index}`;
          slots.set(token, now + request.lease.ttlMs);
          tokens.push({ index, token });
        }
      }
    }
    // After a rate decrease, keep live debt from expiring at its older, earlier time.
    plan.keys.forEach((key, i) => {
      const frame = frames[i]!;
      const value = entries.get(key);
      if (
        frame.algorithm === 'gcra' &&
        !written.has(i) &&
        now < frame.sw &&
        value &&
        value.expires > now &&
        value.a > theta(frame, now)
      )
        value.expires = expiry(
          frame,
          Math.min(value.a, theta(frame, now) + frame.sr * frame.ub),
          now,
        );
    });
    if (entries.size) scopedStates.set(request.id, entries);
    if (slots.size) leases.set(request.id, slots);
    else leases.delete(request.id);
    sweepScoped(plan.keys.length, now);
    return {
      grantedIndexes,
      blocked,
      ...(pause ? { pausedMs: pause } : {}),
      ...(request.lease ? { leases: tokens } : {}),
      ...changed(state, request),
    };
  }
  /** Commit a validated patch, rewrite bounded static expiries, and notify subscribers. */
  function updateLimits(request: ManagedUpdateRequest) {
    const scoped = request.rules.some((rule) => rule.scope !== undefined);
    const patch = checkPatch(request.id, request.rules, request.patch);
    const expect =
      request.expect === undefined
        ? []
        : checkPatch(
            request.id,
            request.rules,
            request.expect,
            'limits expect',
          );
    const now = clock();
    const state = resolve(request, scoped, now, false);
    const result = applyPatch(request.id, state.rules, patch, expect, now);
    managed.set(request.id, state);
    const own = scoped ? policies : staticIds;
    if (!own.has(request.id))
      own.set(request.id, state.updated ? state.structure : state.pin);
    if (result.changed) {
      state.revision++;
      state.updated = true;
      (scoped ? policies : staticIds).set(request.id, state.structure);
      const entries = (scoped ? scopedStates : states).get(request.id);
      for (const rule of request.rules) {
        const frame = state.rules.get(rule.name!)!;
        const value = entries?.get(scoped ? `r:${rule.key}` : rule.key);
        if (
          rule.scope === undefined &&
          frame.algorithm === 'gcra' &&
          value &&
          value.expires > now &&
          value.a > theta(frame, now)
        )
          value.expires = expiry(frame, value.a, now);
      }
      notify(request.id, {
        type: 'limits',
        version: version(state),
        relaxed: result.relaxed,
      });
    }
    return limitsOf(state, request);
  }
  return {
    kind: 'memory',
    acquireScopedSync,
    acquireScoped: (request) => Promise.resolve(acquireScopedSync(request)),
    acquireSync,
    acquire: (request) => Promise.resolve(acquireSync(request)),
    managed: {
      version: 1,
      acquireSync: managedAcquireSync,
      acquire: (request) => Promise.resolve(managedAcquireSync(request)),
      acquireScopedSync: managedScopedSync,
      acquireScoped: (request) => Promise.resolve(managedScopedSync(request)),
      getLimits: (context) => {
        const scoped = context.rules.some((rule) => rule.scope !== undefined);
        return Promise.resolve(
          limitsOf(resolve(context, scoped, clock()), context),
        );
      },
      updateLimits: (request) => {
        try {
          return Promise.resolve(updateLimits(request));
        } catch (error) {
          return Promise.reject(error);
        }
      },
    },
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
      managed.clear();
      scopedStates.clear();
      sweep = undefined;
      pauses.clear();
      leases.clear();
      listeners.clear();
      return Promise.resolve();
    },
  };
}
