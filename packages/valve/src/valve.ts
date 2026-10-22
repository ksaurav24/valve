// Valve scheduler, shared pauses, lifecycle, and provider-aware fetch retries.
import { DelayedQueue } from './delayed.js';
import { scopeSnapshot } from './scoped.js';
import { duration, integer } from './duration.js';
import { emitter } from './emitter.js';
import { failure, invalid } from './errors.js';
import { canReplayBody } from './fetch-body.js';
import type { ValveErrorCode } from './errors.js';
import { defaultFeedback } from './headers/index.js';
import { retryAfterMs } from './headers/parse.js';
import type { ResponseLike } from './headers/types.js';
import { leaseManager } from './leases.js';
import { memoryStore } from './memory-store.js';
import { JobQueue } from './queue.js';
import { normalize } from './rules.js';
import { capacity, checkPatch, compareVersions, relaxes } from './managed.js';
import type {
  AcquireResult,
  LimitsPatch,
  LimitsSnapshot,
  ManagedAcquireResult,
  ManagedScopedResult,
  NormalizedRule,
  ScopedAcquireResult,
  Store,
} from './store.js';
import type {
  FetchLike,
  JobContext,
  PauseReason,
  RunOptions,
  Valve,
  UpdateLimitsOptions,
  ValveOptions,
  WrapFetchOptions,
} from './types.js';

interface Job {
  seq: number;
  priority: number;
  cost: number;
  fn: (ctx: JobContext) => unknown;
  options: RunOptions<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  state: 'queued' | 'running' | 'settled' | 'cancelled';
  timer: ReturnType<typeof setTimeout> | undefined;
  abort: (() => void) | undefined;
  deadline: number;
  waitMs: number;
  lease?: string;
  leaseSignal?: AbortSignal;
  scopes?: Readonly<Record<string, string>>;
  location: 'queue' | 'acquire' | 'delayed' | null;
  // Jobs sent count by which a held zero-wait job must have been sent.
  holdUntil?: number;
}

/** Create a named outbound queue with shared rate rules and local or leased concurrency.
 * @param options Budget, store, queue, and feedback configuration.
 * @returns A valve that queues functions and wraps HTTP clients.
 * @throws {ValveError} INVALID_OPTIONS for invalid configuration.
 * @example const api = createValve({ id: 'github:app-42', rate: { limit: 5000, interval: '1h' } }); await api.run(() => fetch(url));
 */
export function createValve(options: ValveOptions): Valve {
  const config = normalize(options);
  const { id } = config;
  // Managed valves replace their rules with each newer authoritative snapshot.
  let rules: readonly NormalizedRule[] = config.rules;
  const store = options.store ?? memoryStore();
  // Managed admissions use the store's managed capability, which shares the method names.
  const gate = (config.managed ? store.managed : store) as Store;
  let limits: LimitsSnapshot | undefined;
  // Managed store calls issued, and the call that produced the cached limits.
  let limitsIssued = 0;
  let limitsAccepted = 0;
  let limitsWatch: ReturnType<typeof setTimeout> | undefined;
  // Without a subscriber, waits longer than this re-read the limits version.
  const limitsPeriod = store.subscribe ? 10000 : 1000;
  const events = emitter();
  const queue = new JobQueue<Job>();
  const delayed = config.scoped ? new DelayedQueue<Job>() : undefined;
  const waiting = new Set<Job>();
  const feedback =
    options.feedback === false
      ? undefined
      : (options.feedback ?? defaultFeedback);
  const totals = {
    started: 0,
    succeeded: 0,
    failed: 0,
    rejected: 0,
    retried: 0,
    storeErrors: 0,
  };
  let running = 0;
  // Granted jobs retained in waiting for cancellation until invocation.
  let reserved = 0;
  let seq = 0;
  let scheduled = false;
  let inFlight = false;
  let closed = false;
  let pausedUntil = 0;
  let consecutive429 = 0;
  let storeFailures = 0;
  // Outage backoff deadline, kept apart from the wake timer that aborts reset.
  let backoffUntil = 0;
  // Consecutive lease denials, which widen the window for answering release notices.
  let contention = 0;
  // False while a rate rule, which slot releases cannot change, blocks the queue head.
  let leaseWait = true;
  let lastStoreEvent = -Infinity;
  let wake: ReturnType<typeof setTimeout> | undefined;
  let wakeAt = Infinity;
  let idleResolvers: (() => void)[] = [];
  let closePromise: Promise<void> | undefined;
  let closeResolve: (() => void) | undefined;
  let closingStore = false;
  let draining = false;
  // Bounds how long close() waits for an in-flight global admission.
  let closeWait: ReturnType<typeof setTimeout> | undefined;
  let waitedOut = false;
  // wrapFetch calls between a retryable response and queueing the retry.
  let retrying = 0;
  let active = false;
  const costs: number[] = [];
  const owner = config.global ? globalThis.crypto.randomUUID() : '';
  let leaseSequence = 0;
  let unsubscribe: (() => void) | undefined;
  let noticeVersion = 0;
  // Zero-wait jobs whose expiry ran while another batch was in flight. They wait
  // for the scheduler, not for capacity, so they keep their single attempt.
  const held = new Set<Job>();
  let heldCheck: ReturnType<typeof setTimeout> | undefined;
  // Jobs sent in asynchronous admissions, which bounds how long a job stays held.
  let sent = 0;
  const leases = config.global
    ? leaseManager(store, id, config.leaseTtl, reportStore, () => {
        if (!leaseWait) return;
        delayed?.wake();
        clearWake();
        schedule();
      })
    : undefined;

  /** Cancel the current wake hint without resetting the separate outage backoff deadline. */
  function clearWake() {
    if (wake !== undefined) clearTimeout(wake);
    wake = undefined;
    wakeAt = Infinity;
  }
  /** Coalesce wake requests into one scheduler microtask. */
  function schedule() {
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(pump);
    }
  }
  /** Keep the earliest wake hint and cap its timer delay at the platform maximum. */
  function arm(at: number) {
    if (!waiting.size || at >= wakeAt) return;
    clearWake();
    wakeAt = at;
    wake = setTimeout(
      () => {
        wake = undefined;
        wakeAt = Infinity;
        schedule();
      },
      Math.min(2147483647, Math.max(1, Math.ceil(at - Date.now()))),
    );
    if (config.managed) watchLimits(at);
  }
  /** Managed context sent with every store call, seeded by the newest observed limits. */
  function context() {
    return {
      id,
      rules,
      ...(config.global
        ? {
            lease: {
              limit: config.concurrency,
              ttlMs: config.leaseTtl,
              owner: `${owner}:${leaseSequence++}`,
            },
          }
        : {}),
      ...(limits ? { known: limits.version } : {}),
    };
  }
  /**
   * Cache a snapshot unless an older one arrives late. A snapshot from a later
   * call is accepted even when its version is older, after a failover or restore.
   * @returns Whether it raises any limit or burst over the previous cache.
   */
  function accept(next: LimitsSnapshot | undefined, issued: number) {
    if (!next) return false;
    if (
      typeof next.version !== 'string' ||
      !/^\d+\.\d+$/.test(next.version) ||
      !Number.isSafeInteger(Number(next.version.split('.')[0])) ||
      !Number.isSafeInteger(next.revision) ||
      next.revision < 1 ||
      Number(next.version.split('.')[1]) !== next.revision ||
      !next.rules ||
      typeof next.rules !== 'object' ||
      Object.keys(next.rules).length !== rules.length ||
      rules.some((rule) => {
        const value = next.rules[rule.name!];
        return (
          !Object.hasOwn(next.rules, rule.name!) ||
          !value ||
          value.algorithm !== rule.algorithm ||
          value.intervalMs !== rule.intervalMs ||
          value.scope !== rule.scope ||
          !Number.isSafeInteger(value.limit) ||
          value.limit < 1 ||
          !Number.isSafeInteger(value.burst) ||
          value.burst < 1 ||
          (rule.algorithm === 'fixed-window' && value.burst !== 1)
        );
      })
    )
      throw failure(
        id,
        'INVALID_OPTIONS',
        'Store returned invalid managed limits.',
      );
    if (next.version === limits?.version) return false;
    const previous = limits;
    const order = previous
      ? compareVersions(next.version, previous.version)
      : 1;
    if (order < 0 && issued <= limitsAccepted) return false;
    const epoch = (version: string) => version.slice(0, version.indexOf('.'));
    if (previous && epoch(previous.version) !== epoch(next.version))
      events.emit('warning', {
        message:
          order < 0
            ? 'Managed limits went back to an older version after a store failover or restore. Reapply recent updateLimits calls.'
            : 'The store registered managed limits again after losing them, so earlier updates may be lost. Reapply them with updateLimits.',
      });
    else if (order < 0)
      events.emit('warning', {
        message:
          'Managed limits went back to an older revision after a store failover or restore. Reapply recent updateLimits calls.',
      });
    else if (
      !previous &&
      config.rules.some(
        (rule) =>
          next.rules[rule.name!]?.limit !== rule.limit ||
          next.rules[rule.name!]?.burst !== rule.burst,
      )
    )
      events.emit('warning', {
        message:
          "The store has managed limits that differ from this valve's configured rules; the store's values apply.",
      });
    limits = next;
    limitsAccepted = Math.max(limitsAccepted, issued);
    rules = Object.freeze(
      rules.map((rule) => {
        const value = next.rules[rule.name!];
        return value
          ? Object.freeze({ ...rule, limit: value.limit, burst: value.burst })
          : rule;
      }),
    );
    events.emit('limits', next);
    return !previous || relaxes(previous, next);
  }
  /** Cache limits carried by a managed admission reply. */
  function observed<R>(result: R, issued: number): R {
    if (config.managed && result && typeof result === 'object')
      accept((result as { limits?: LimitsSnapshot }).limits, issued);
    return result;
  }
  /** Re-evaluate every waiting job now that some capacity grew. */
  function relax() {
    noticeVersion++;
    delayed?.wake();
    clearWake();
    schedule();
  }
  /** Without reliable notices, re-read the limits version during long waits. */
  function watchLimits(at: number) {
    if (limitsWatch !== undefined || at - Date.now() <= limitsPeriod) return;
    limitsWatch = setTimeout(() => {
      limitsWatch = undefined;
      if (!waiting.size || closingStore || pausedUntil > Date.now()) return;
      const issued = ++limitsIssued;
      void Promise.resolve()
        .then(() => store.managed!.getLimits(context()))
        .then((next) => {
          if (accept(next, issued)) relax();
          else if (waiting.size) watchLimits(wakeAt);
        })
        .catch((error) => {
          reportStore(error);
          if (waiting.size) watchLimits(wakeAt);
        });
    }, limitsPeriod);
  }
  /** Reject a job that exceeds a rule's current capacity and so can never start. */
  function impossible(job: Job) {
    const rule = rules.find((candidate) => job.cost > capacity(candidate));
    rejectJob(
      job,
      'COST_EXCEEDS_LIMIT',
      `job cost ${job.cost} is greater than the current ${rule?.algorithm === 'fixed-window' ? 'limit' : 'burst'}${rule ? ` ${capacity(rule)} of rule ${rule.name}` : ''} (managed limits ${limits?.version ?? 'unknown'}), so it can never start. Raise it with updateLimits or lower the cost.`,
    );
  }
  /** Spread retries by up to 25ms, bounded by ten percent of the supplied delay. */
  function jitter(ms: number) {
    return Math.random() * Math.min(25, ms * 0.1);
  }
  /** Spread re-polls caused by shared notices so waiting valves do not answer at once.
   * Valves that keep losing lease races widen their window, up to the 50ms poll. */
  function soon() {
    delayed?.wake();
    if (!contention) {
      clearWake();
      schedule();
    } else arm(Date.now() + Math.random() * Math.min(50, 2 ** contention));
  }
  /** Poll lease waits every 50ms without a subscriber, and every second with
   * one in case a release notice is missed. Rate waits follow the hint. */
  function retryDelay(retryAfterMs: number, leaseBlocked?: boolean) {
    return config.global && leaseBlocked !== false
      ? Math.min(store.subscribe ? 1000 : 50, retryAfterMs)
      : retryAfterMs;
  }
  function cleanup(job: Job) {
    if (job.timer !== undefined) clearTimeout(job.timer);
    job.timer = undefined;
    if (job.abort) job.options.signal?.removeEventListener('abort', job.abort);
    job.abort = undefined;
    if (held.delete(job) && !held.size) {
      clearTimeout(heldCheck);
      heldCheck = undefined;
    }
  }
  /** End an asynchronous admission, then give held jobs one timer turn to be sent. */
  function admitted() {
    inFlight = false;
    if (held.size) heldCheck ??= setTimeout(expireHeld, 0);
  }
  /** Reject held zero-wait jobs the scheduler could not send after the last reply,
   * or that other work (newer, or retried) kept out of the batches that sent the
   * backlog they joined. Their rejection frees no capacity, so no pump follows. */
  function expireHeld() {
    heldCheck = undefined;
    for (const job of held)
      if (job.location === 'queue' && (!inFlight || sent >= job.holdUntil!))
        missed(job);
  }
  function finishIdle() {
    if (waiting.size || running || retrying) return;
    clearWake();
    clearTimeout(limitsWatch);
    limitsWatch = undefined;
    if (active) {
      active = false;
      events.emit('idle', {});
    }
    const resolvers = idleResolvers;
    idleResolvers = [];
    for (const resolve of resolvers) resolve();
    // A pending global admission can still return leases that must be released.
    if (closed && closeResolve && !closingStore) {
      if (inFlight && leases && !waitedOut) {
        // Leases granted by a store that never answers expire within leaseTtl.
        closeWait ??= setTimeout(() => {
          waitedOut = true;
          finishIdle();
        }, config.leaseTtl);
        return;
      }
      clearTimeout(closeWait);
      closingStore = true;
      unsubscribe?.();
      void (leases?.close() ?? Promise.resolve())
        .then(() => (options.store ? undefined : store.close()))
        .then(closeResolve, (error) => {
          reportStore(error);
          closeResolve?.();
        });
    }
  }
  /** Reject only queued work, removing it from either queue and releasing its timers/listeners. */
  function rejectJob(
    job: Job,
    code: ValveErrorCode,
    message: string,
    cause?: unknown,
  ) {
    if (job.state !== 'queued') return;
    if (job.location === null) reserved--;
    if (job.location === 'delayed') delayed!.remove(job);
    if (job.location === 'queue') queue.cancel(job);
    else job.state = 'cancelled';
    job.location = null;
    waiting.delete(job);
    cleanup(job);
    totals.rejected++;
    job.reject(failure(id, code, message, cause));
    events.emit('reject', { code });
    if (!waiting.size) clearWake();
    finishIdle();
  }
  function refuse(error: unknown) {
    totals.rejected++;
    events.emit('reject', {
      code: (error as { code?: ValveErrorCode })?.code ?? 'INVALID_OPTIONS',
    });
  }
  function reportStore(error: unknown) {
    totals.storeErrors++;
    const now = Date.now();
    if (now - lastStoreEvent >= 1000) {
      lastStoreEvent = now;
      events.emit('store-error', { error, policy: config.policy });
    }
  }
  /** Reject a `maxWait: 0` job instead of requeueing it after its single admission attempt. */
  function missed(job: Job) {
    if (job.waitMs) return false;
    rejectJob(
      job,
      'MAX_WAIT_EXCEEDED',
      'job could not start immediately with maxWait 0ms.',
    );
    return true;
  }
  /** Requeue live work, rejecting zero-wait jobs after their sole admission attempt. */
  function enqueueAgain(job: Job) {
    if (job.state === 'queued' && !missed(job)) {
      job.location = 'queue';
      queue.push(job);
    }
  }
  /** Record an outcome; leased replacements wake after the store releases the slot. */
  function settle(job: Job, ok: boolean, result: unknown) {
    job.state = 'settled';
    running--;
    if (job.lease) {
      const error = leases!.error(job.lease);
      if (error) {
        ok = false;
        result = error;
      }
      leases!.release(job.lease);
    }
    totals[ok ? 'succeeded' : 'failed']++;
    if (ok) job.resolve(result);
    else job.reject(result);
    finishIdle();
    // A released lease wakes the valve once the store has the slot back.
    if (!job.lease) schedule();
  }
  /** Reserve capacity, then check eligibility immediately before invoking a grant. */
  function start(job: Job) {
    running++;
    if (job.state === 'queued') reserved++;
    job.location = null;
    // Jobs always execute in a microtask, including the memory fast path.
    queueMicrotask(() => {
      if (job.state === 'queued' && job.waitMs && job.deadline <= Date.now())
        rejectJob(
          job,
          'MAX_WAIT_EXCEEDED',
          `job waited longer than maxWait ${job.waitMs}ms.`,
        );
      if (job.state !== 'queued') {
        running--;
        if (job.lease) leases!.release(job.lease);
        else schedule();
        finishIdle();
        return;
      }
      reserved--;
      waiting.delete(job);
      cleanup(job);
      job.state = 'running';
      totals.started++;
      const leaseError = job.lease ? leases!.error(job.lease) : undefined;
      if (leaseError) {
        settle(job, false, leaseError);
        return;
      }
      let result: unknown;
      try {
        result = job.fn({ signal: job.leaseSignal ?? job.options.signal });
      } catch (error) {
        settle(job, false, error);
        return;
      }
      if (
        result &&
        (typeof result === 'object' || typeof result === 'function') &&
        'then' in result
      ) {
        Promise.resolve(result).then(
          (value) => succeed(job, value),
          (error) => settle(job, false, error),
        );
      } else succeed(job, result);
    });
  }
  function succeed(job: Job, result: unknown) {
    try {
      const response = job.options.observe?.(result);
      if (response) observe(response);
    } catch (error) {
      events.emit('warning', {
        message: `Response observer threw: ${String(error)}`,
      });
    }
    settle(job, true, result);
  }
  /** Apply static grants and schedule denied work using its rate or lease retry hint. */
  function handle(
    heads: Job[],
    result: AcquireResult,
    acquiredAt = Date.now(),
    version = noticeVersion,
    acquiredTime?: number,
  ) {
    const now = Date.now();
    if (
      config.managed &&
      (!result ||
        !Number.isSafeInteger(result.granted) ||
        result.granted < 0 ||
        result.granted > heads.length ||
        !Number.isSafeInteger(result.retryAfterMs) ||
        result.retryAfterMs < 0 ||
        !Number.isSafeInteger(result.pausedMs) ||
        result.pausedMs < 0)
    ) {
      storeError(
        heads,
        failure(
          id,
          'INVALID_OPTIONS',
          'Store returned invalid managed grants.',
        ),
      );
      return;
    }
    if (
      config.global &&
      result.granted > 0 &&
      ((config.managed && !Array.isArray(result.leases)) ||
        result.leases?.length !== result.granted ||
        new Set(result.leases).size !== result.granted ||
        (config.managed &&
          result.leases.some(
            (token) => typeof token !== 'string' || token.length === 0,
          )))
    ) {
      storeError(
        heads,
        config.managed
          ? failure(
              id,
              'INVALID_OPTIONS',
              'Store returned invalid global lease tokens',
            )
          : new Error('Store returned invalid global lease tokens'),
      );
      return;
    }
    storeFailures = 0;
    backoffUntil = 0;
    if (result.pausedMs > 0 && version !== noticeVersion) {
      for (const job of heads) enqueueAgain(job);
      clearWake();
      schedule();
      return;
    }
    if (result.pausedMs > 0) {
      for (const job of heads) enqueueAgain(job);
      if (pausedUntil <= now)
        events.emit('pause', { durationMs: result.pausedMs, reason: 'store' });
      pausedUntil = Math.max(pausedUntil, now + result.pausedMs);
      arm(pausedUntil);
      finishIdle();
      return;
    }
    if (config.global) {
      leaseWait =
        result.granted === heads.length || result.leaseBlocked !== false;
      contention = result.granted
        ? 0
        : leaseWait
          ? Math.min(contention + 1, 6)
          : contention;
    }
    const cannot = (result as ManagedAcquireResult).impossible === true;
    for (let i = 0; i < heads.length; i++) {
      const job = heads[i]!;
      if (cannot && i === result.granted && version === noticeVersion)
        impossible(job);
      else if (i < result.granted) {
        if (leases) {
          job.lease = result.leases![i]!;
          if (now >= acquiredAt + config.leaseTtl) {
            leases.release(job.lease);
            rejectJob(
              job,
              'LEASE_LOST',
              'global lease expired before the job could start.',
            );
            continue;
          }
          if (job.state === 'queued')
            job.leaseSignal = leases.claim(
              job.lease,
              acquiredAt + config.leaseTtl,
              job.options.signal,
            );
        }
        start(job);
      } else enqueueAgain(job);
    }
    if (cannot) schedule();
    else if (
      result.granted < heads.length &&
      version !== noticeVersion &&
      leaseWait
    )
      soon();
    else if (result.granted < heads.length)
      arm(
        now +
          Math.max(
            1,
            config.global
              ? retryDelay(result.retryAfterMs, result.leaseBlocked)
              : // The next rate check can overlap time spent obtaining the answer.
                // Admission remains authoritative if this estimate wakes early.
                result.retryAfterMs -
                  (acquiredTime === undefined
                    ? 0
                    : performance.now() - acquiredTime),
          ) +
          // Global waits may be blocked on contended slots; rate-only waits need no jitter.
          (config.global ? jitter(result.retryAfterMs) : 0),
      );
    else if (waiting.size) schedule();
    finishIdle();
  }
  /**
   * Validate a complete partition of grants and denials before starting any job.
   * Granted jobs reuse the lease/lifecycle handler; denied jobs wait on eligibility
   * hints unless a newer store notification requires immediate reconsideration.
   */
  function handleScoped(
    heads: Job[],
    result: ScopedAcquireResult,
    acquiredAt: number,
    version: number,
  ) {
    const indexes = new Set<number>();
    /** Accept each in-range job index once across both grants and denials. */
    const validIndex = (index: number) =>
      Number.isInteger(index) &&
      index >= 0 &&
      index < heads.length &&
      !indexes.has(index) &&
      !!indexes.add(index);
    if (
      !result ||
      !Array.isArray(result.grantedIndexes) ||
      !Array.isArray(result.blocked) ||
      !result.grantedIndexes.every(validIndex) ||
      (result.pausedMs !== undefined &&
        !(Number.isSafeInteger(result.pausedMs) && result.pausedMs >= 0)) ||
      !result.blocked.every(
        (entry) =>
          entry &&
          validIndex(entry.index) &&
          Number.isSafeInteger(entry.retryAfterMs) &&
          entry.retryAfterMs > 0,
      ) ||
      indexes.size !== heads.length ||
      (config.global &&
        (!Array.isArray(result.leases) ||
          result.leases.length !== result.grantedIndexes.length ||
          !result.leases.every(
            (entry) =>
              entry &&
              Number.isInteger(entry.index) &&
              typeof entry.token === 'string',
          ) ||
          new Set(result.leases.map((entry) => entry.token)).size !==
            result.leases.length ||
          new Set(result.leases.map((entry) => entry.index)).size !==
            result.leases.length ||
          !result.leases.every(
            (entry) =>
              result.grantedIndexes.includes(entry.index) &&
              typeof entry.token === 'string' &&
              entry.token.length > 0,
          )))
    ) {
      storeError(
        heads,
        config.managed
          ? failure(
              id,
              'INVALID_OPTIONS',
              'Store returned invalid scoped grants or lease tokens',
            )
          : new Error('Store returned invalid scoped grants or lease tokens'),
      );
      return;
    }
    storeFailures = 0;
    backoffUntil = 0;
    const now = Date.now();
    if (result.pausedMs && version === noticeVersion) {
      if (pausedUntil <= now)
        events.emit('pause', { durationMs: result.pausedMs, reason: 'store' });
      pausedUntil = Math.max(pausedUntil, now + result.pausedMs);
      arm(pausedUntil);
    }
    const tokens = new Map(
      result.leases?.map((entry) => [entry.index, entry.token]),
    );
    for (const index of result.grantedIndexes) {
      const job = heads[index]!;
      handle(
        [job],
        {
          granted: 1,
          retryAfterMs: 0,
          pausedMs: 0,
          ...(config.global ? { leases: [tokens.get(index)!] } : {}),
        },
        acquiredAt,
        version,
      );
    }
    if (config.global) {
      leaseWait =
        !result.blocked.length ||
        result.blocked.some((entry) => entry.leaseBlocked !== false);
      contention = result.grantedIndexes.length
        ? 0
        : leaseWait
          ? Math.min(contention + 1, 6)
          : contention;
    }
    for (const entry of (result as ManagedScopedResult).blocked) {
      const job = heads[entry.index]!;
      if (
        entry.impossible &&
        version === noticeVersion &&
        job.state === 'queued'
      )
        impossible(job);
      if (job.state !== 'queued' || missed(job)) continue;
      if (version !== noticeVersion) enqueueAgain(job);
      else {
        job.location = 'delayed';
        delayed!.add(
          job,
          now + Math.max(1, retryDelay(entry.retryAfterMs, entry.leaseBlocked)),
        );
      }
    }
    arm(delayed!.next);
    if (queue.size) {
      if (config.global && version !== noticeVersion) soon();
      else schedule();
    }
    finishIdle();
  }
  /** Reject configuration failures; apply the outage policy to other store errors.
   * Error codes also identify configuration failures across ESM/CJS and package
   * copies, where ValveError class identities can differ.
   * @param heads Jobs included in the failed admission request.
   * @param error Store rejection reported to listeners and used as the cause when rejecting jobs.
   */
  function storeError(heads: Job[], error: unknown) {
    reportStore(error);
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'INVALID_OPTIONS'
    ) {
      for (const job of heads)
        rejectJob(
          job,
          'INVALID_OPTIONS',
          'store rejected the shared quota configuration. Use identical settings on every worker or follow the shared quota migration procedure.',
          error,
        );
      schedule();
    } else if (config.policy === 'open') {
      for (const job of heads) start(job);
      schedule();
    } else if (config.policy === 'throw') {
      for (const job of heads)
        rejectJob(
          job,
          'STORE_UNAVAILABLE',
          'store is unavailable. Check the store connection or choose onStoreError wait.',
          error,
        );
      schedule();
    } else {
      const delay = Math.min(5000, 100 * 2 ** Math.min(storeFailures++, 6));
      const at = Date.now() + delay + jitter(delay);
      backoffUntil = at;
      for (const job of heads) {
        if (delayed && job.state === 'queued' && !missed(job)) {
          job.location = 'delayed';
          delayed.add(job, at);
        } else enqueueAgain(job);
      }
      arm(at);
    }
    finishIdle();
  }
  /**
   * Advance bounded scheduler work with at most one asynchronous admission in flight.
   * Promote all due scoped jobs before selecting by priority, then acquire only
   * live jobs that fit the available concurrency and configured batch size.
   */
  function pump() {
    scheduled = false;
    if (inFlight) return;
    const now = Date.now();
    if (!waiting.size) {
      finishIdle();
      return;
    }
    if (pausedUntil && pausedUntil <= now) {
      pausedUntil = 0;
      events.emit('resume', { reason: 'expired' });
    }
    if (pausedUntil > now) {
      arm(pausedUntil);
      return;
    }
    if (backoffUntil > now) {
      arm(backoffUntil);
      return;
    }
    if (delayed) {
      for (const job of delayed.take(now, config.batch)) enqueueAgain(job);
      // Promote all currently eligible jobs before choosing by priority. Each
      // pump does bounded heap work, including after a long event-loop stall.
      if (delayed.next <= now) {
        schedule();
        return;
      }
      arm(delayed.next);
    } else if (wakeAt > now && wakeAt !== Infinity) return;
    const free = config.concurrency - running;
    if (free <= 0 || queue.size === 0) return;
    const heads = queue.take(Math.min(free, config.batch));
    for (const job of heads) job.location = 'acquire';
    const live: Job[] = [];
    for (const job of heads) {
      // A zero maxWait gets one admission attempt instead of a deadline.
      if (job.waitMs && job.deadline <= now)
        rejectJob(
          job,
          'MAX_WAIT_EXCEEDED',
          `job waited longer than maxWait ${job.waitMs}ms.`,
        );
      else live.push(job);
    }
    if (!live.length) {
      schedule();
      return;
    }
    // Concurrency-only valves still consult the pause in their shared store.
    costs.length = 0;
    for (const job of live) costs.push(job.cost);
    const request = config.managed
      ? { ...context(), costs }
      : {
          id,
          rules,
          costs,
          ...(config.global
            ? {
                lease: {
                  limit: config.concurrency,
                  ttlMs: config.leaseTtl,
                  owner: `${owner}:${leaseSequence++}`,
                },
              }
            : {}),
        };
    const acquiredAt = Date.now();
    const version = noticeVersion;
    const issued = config.managed ? ++limitsIssued : 0;
    if (config.scoped) {
      const scopedRequest = {
        ...(config.managed && limits ? { known: limits.version } : {}),
        id,
        rules,
        jobs: live.map((job) => ({ cost: job.cost, scopes: job.scopes! })),
        ...(request.lease ? { lease: request.lease } : {}),
      };
      if (gate.acquireScopedSync) {
        try {
          handleScoped(
            live,
            observed(gate.acquireScopedSync(scopedRequest), issued),
            acquiredAt,
            version,
          );
        } catch (error) {
          storeError(live, error);
        }
      } else {
        inFlight = true;
        sent += live.length;
        try {
          gate.acquireScoped!(scopedRequest).then(
            (value) => {
              admitted();
              try {
                handleScoped(
                  live,
                  observed(value, issued),
                  acquiredAt,
                  version,
                );
              } catch (error) {
                storeError(live, error);
              }
            },
            (error) => {
              admitted();
              storeError(live, error);
            },
          );
        } catch (error) {
          admitted();
          storeError(live, error);
        }
      }
      return;
    }
    if (gate.acquireSync) {
      try {
        handle(
          live,
          observed(gate.acquireSync(request), issued),
          acquiredAt,
          version,
        );
      } catch (error) {
        storeError(live, error);
      }
      return;
    }
    inFlight = true;
    sent += live.length;
    const acquiredTime = config.global ? undefined : performance.now();
    let result: Promise<AcquireResult>;
    try {
      result = gate.acquire(request);
    } catch (error) {
      admitted();
      storeError(live, error);
      return;
    }
    result.then(
      (value) => {
        admitted();
        try {
          handle(
            live,
            observed(value, issued),
            acquiredAt,
            version,
            acquiredTime,
          );
        } catch (error) {
          storeError(live, error);
        }
      },
      (error) => {
        admitted();
        storeError(live, error);
      },
    );
  }
  /**
   * Validate and snapshot one submission before enqueueing it with cancellation and a deadline.
   * @param originalSeq Reuse the logical request's submission order for fetch retries.
   * @param retry Admit a fetch retry while draining and after its queue slot was checked.
   * @returns The job result, or a rejection for invalid options, cancellation, or execution failure.
   */
  function submit<R>(
    fn: (ctx: JobContext) => R,
    jobOptions: RunOptions<Awaited<R>> = {},
    originalSeq?: number,
    retry = false,
  ): Promise<Awaited<R>> {
    return new Promise<Awaited<R>>((resolve, reject) => {
      try {
        if (closed && !(retry && draining))
          throw failure(id, 'CLOSED', 'valve is closed.');
        if (typeof fn !== 'function')
          invalid(id, 'job must be a function', fn, 'Pass a function to run');
        const scopes =
          config.scoped || jobOptions.scopes !== undefined
            ? scopeSnapshot(id, config.scopes, jobOptions.scopes)
            : undefined;
        const cost = integer(jobOptions.cost ?? 1, id, 'job cost');
        const priority = jobOptions.priority ?? 0;
        if (!Number.isSafeInteger(priority))
          invalid(
            id,
            'job priority must be an integer',
            priority,
            'Use an integer priority',
          );
        const maxWait =
          jobOptions.maxWait === undefined
            ? config.maxWait
            : duration(jobOptions.maxWait, id, 'job maxWait');
        // Managed stores judge capacity against their authoritative limits.
        if (!config.managed)
          for (const rule of rules) {
            const capacity =
              rule.algorithm === 'gcra' ? rule.burst : rule.limit;
            if (cost > capacity)
              throw failure(
                id,
                'COST_EXCEEDS_LIMIT',
                `job cost ${cost} is greater than ${rule.algorithm === 'gcra' ? 'burst' : 'limit'} ${capacity} of rule ${rule.key}, so it can never start. Set ${rule.algorithm === 'gcra' ? 'burst' : 'limit'} to at least ${cost} on that rule.`,
              );
          }
        if (jobOptions.signal?.aborted)
          throw failure(
            id,
            'ABORTED',
            'job was aborted before starting.',
            jobOptions.signal.reason,
          );
        if (!retry && waiting.size - reserved >= config.maxQueue)
          throw failure(
            id,
            'QUEUE_FULL',
            `queue is full (maxQueue ${config.maxQueue}). Raise maxQueue, or shed load before calling run.`,
          );
        const job: Job = {
          seq: originalSeq ?? seq++,
          priority,
          cost,
          fn,
          options: jobOptions as RunOptions<unknown>,
          resolve: resolve as (value: unknown) => void,
          reject,
          state: 'queued',
          timer: undefined,
          abort: undefined,
          deadline: maxWait === Infinity ? Infinity : Date.now() + maxWait,
          waitMs: maxWait,
          location: 'queue',
          ...(scopes ? { scopes } : {}),
        };
        waiting.add(job);
        queue.push(job);
        active = true;
        if (maxWait !== Infinity) {
          const expire = () => {
            // The pending admission settles a zero-wait job. One queued behind
            // it is held until the scheduler can send it.
            if (!maxWait && (job.location === 'acquire' || inFlight)) {
              if (job.location === 'queue') {
                held.add(job);
                // Sending as many jobs as are queued now reaches this one
                // unless other work goes first.
                job.holdUntil = sent + queue.size;
              }
              return;
            }
            const left = job.deadline - Date.now();
            if (left > 0) {
              job.timer = setTimeout(expire, Math.min(2147483647, left));
              return;
            }
            rejectJob(
              job,
              'MAX_WAIT_EXCEEDED',
              `job waited longer than maxWait ${maxWait}ms.`,
            );
            clearWake();
            schedule();
          };
          job.timer = setTimeout(expire, Math.min(2147483647, maxWait));
        }
        if (jobOptions.signal) {
          job.abort = () => {
            rejectJob(
              job,
              'ABORTED',
              'job was aborted before starting.',
              jobOptions.signal?.reason,
            );
            clearWake();
            schedule();
          };
          jobOptions.signal.addEventListener('abort', job.abort, {
            once: true,
          });
        }
        schedule();
      } catch (error) {
        refuse(error);
        reject(error);
      }
    });
  }
  /** Run a managed limits call, reporting store failures as STORE_UNAVAILABLE. */
  function call<T>(operation: () => Promise<T>): Promise<T> {
    return Promise.resolve()
      .then(operation)
      .catch((error: unknown) => {
        if ((error as { name?: unknown })?.name === 'ValveError') throw error;
        reportStore(error);
        throw failure(
          id,
          'STORE_UNAVAILABLE',
          'store failed during a managed limits call. If it timed out, an update may still apply. Read the current limits and use expect when retrying to avoid overwriting another writer.',
          error,
        );
      });
  }
  function sharedPause(ms: number, reason: PauseReason): Promise<void> {
    pausedUntil = Math.max(pausedUntil, Date.now() + ms);
    events.emit('pause', { durationMs: ms, reason });
    clearWake();
    arm(pausedUntil);
    try {
      return store.pause(id, ms);
    } catch (error) {
      return Promise.reject(error);
    }
  }
  function observe(response: ResponseLike): void {
    let signal;
    try {
      signal = feedback?.(response);
    } catch (error) {
      events.emit('warning', {
        message: `Feedback reader threw: ${String(error)}`,
      });
    }
    consecutive429 = response.status === 429 ? consecutive429 + 1 : 0;
    let ms = signal?.pauseMs ?? 0;
    let reason: PauseReason = 'feedback';
    if (!(ms > 0) && signal?.remaining !== undefined && signal.remaining <= 0)
      ms = signal.resetMs ?? 0;
    if (!(ms > 0) && response.status === 429) {
      ms = Math.min(
        config.backoffMax,
        config.backoffBase * 2 ** Math.min(consecutive429 - 1, 52),
      );
      reason = 'backoff';
    }
    if (!(ms > 0)) return;
    if (ms > config.maxPause) {
      events.emit('warning', {
        message: `Pause ${ms}ms exceeds maxPause ${config.maxPause}ms; capped.`,
      });
      ms = config.maxPause;
    }
    if (ms > 0) void sharedPause(ms, reason).catch(reportStore);
  }
  /**
   * Wrap a fetch implementation with admission, provider feedback, and bounded safe retries.
   * Each logical call snapshots resolved identities once; every retry reacquires its budgets.
   */
  function wrapFetch<F extends FetchLike = typeof fetch>(
    fetchImpl?: F,
    fetchOptions: WrapFetchOptions<F> = {},
  ): F {
    const impl = fetchImpl ?? (globalThis.fetch as unknown as F);
    if (typeof impl !== 'function')
      invalid(
        id,
        'fetchImpl must be a function',
        impl,
        'Pass a fetch implementation',
      );
    const retries = fetchOptions.retries ?? 2;
    const maxReplayBodySize = fetchOptions.maxReplayBodySize ?? 64 * 1024;
    for (const [name, value] of [
      ['retries', retries],
      ['maxReplayBodySize', maxReplayBodySize],
    ] as const)
      if (!Number.isSafeInteger(value) || value < 0)
        invalid(
          id,
          `${name} must be a nonnegative integer`,
          value,
          'Use zero to disable replay',
        );
    if (fetchOptions.maxWait !== undefined)
      duration(fetchOptions.maxWait, id, 'wrapFetch.maxWait');
    /** Resolve per-call options once and retry only when method and request-body replay allow it. */
    const limited = async (...args: Parameters<F>): Promise<ResponseLike> => {
      const values = args as unknown as [
        RequestInfo | URL,
        RequestInit | undefined,
      ];
      const input = values[0];
      const init = values[1];
      const request =
        typeof Request !== 'undefined' && input instanceof Request
          ? input
          : undefined;
      const stream =
        typeof ReadableStream !== 'undefined' &&
        init?.body instanceof ReadableStream;
      const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
      const retryable =
        fetchOptions.retryUnsafeMethods === true ||
        ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'].includes(method);
      const inheritedBody = request?.body && init?.body == null;
      let attempts =
        stream || !retryable || (inheritedBody && maxReplayBodySize === 0)
          ? 0
          : retries;
      /** Read a fixed option or call its resolver with the fetch arguments. */
      const option = <T>(value: T | ((...a: Parameters<F>) => T)) =>
        typeof value === 'function'
          ? (value as (...a: Parameters<F>) => T)(...args)
          : value;
      let cost, priority, scopes;
      try {
        cost = option(fetchOptions.cost);
        priority = option(fetchOptions.priority);
        const identities = option(fetchOptions.scopes);
        scopes =
          config.scoped || identities !== undefined
            ? scopeSnapshot(id, config.scopes, identities)
            : undefined;
      } catch (error) {
        refuse(error);
        throw error;
      }
      const signal = init?.signal ?? request?.signal;
      const originalSeq = seq++;
      const runOptions: RunOptions<ResponseLike> = {
        ...(scopes ? { scopes } : {}),
        ...(cost === undefined ? {} : { cost }),
        ...(priority === undefined ? {} : { priority }),
        ...(signal == null ? {} : { signal }),
        ...(fetchOptions.maxWait === undefined
          ? {}
          : { maxWait: fetchOptions.maxWait }),
      };
      // Holds close() and idle() open from a retryable response until its retry is queued.
      let held = false;
      const release = () => {
        if (held) {
          held = false;
          retrying--;
          finishIdle();
        }
      };
      for (let attempt = 0; ; attempt++) {
        const callArgs = [...args] as Parameters<F>;
        const pending = submit(
          async (ctx) => {
            if (inheritedBody && attempts > 0) {
              if (
                attempt === 0 &&
                !(await canReplayBody(request!, maxReplayBodySize, ctx.signal))
              )
                attempts = 0;
              if (attempts > 0) (callArgs as unknown[])[0] = request!.clone();
            }
            if (config.global)
              (callArgs as unknown[])[1] = { ...init, signal: ctx.signal };
            const res = await impl(...(callArgs as never[]));
            observe(res);
            if (
              attempt < attempts &&
              (res.status === 429 ||
                (res.status === 503 && retryAfterMs(res.headers) !== undefined))
            ) {
              held = true;
              retrying++;
            }
            return res;
          },
          runOptions,
          originalSeq,
          attempt > 0,
        );
        release();
        let response: ResponseLike;
        try {
          response = await pending;
        } catch (error) {
          release();
          throw error;
        }
        if (!held) return response;
        // Return the provider response when its retry cannot be queued.
        if (
          (closed && !draining) ||
          waiting.size - reserved >= config.maxQueue
        ) {
          release();
          return response;
        }
        // Queue the retry before anything else can close the valve; cancel the
        // discarded body in the background.
        Promise.resolve()
          .then(() => (response as Response).body?.cancel())
          .catch(() => {
            /* A body already consumed by the client needs no cleanup. */
          });
        totals.retried++;
      }
    };
    return limited as unknown as F;
  }
  function close(closeOptions: { drain?: boolean } = {}): Promise<void> {
    if (closePromise) return closePromise;
    closed = true;
    draining = !!closeOptions.drain;
    closePromise = new Promise((resolve) => {
      closeResolve = resolve;
    });
    if (!closeOptions.drain) {
      for (const job of waiting) rejectJob(job, 'CLOSED', 'valve is closed.');
      clearWake();
    }
    schedule();
    finishIdle();
    return closePromise;
  }
  if (store.subscribe) {
    /** Invalidate pending admission hints and wake scheduling when shared pause or lease state changes. */
    const listener: Parameters<NonNullable<typeof store.subscribe>>[1] = (
      notice,
    ) => {
      if (closed && closingStore) return;
      if (notice.type === 'limits') {
        // Only a raised limit or burst can admit sooner than existing retry hints.
        if (
          notice.relaxed &&
          notice.version !== limits?.version &&
          waiting.size
        ) {
          noticeVersion++;
          delayed?.wake();
          arm(Date.now() + Math.random() * 25);
        }
        return;
      }
      noticeVersion++;
      if (notice.type === 'resume') delayed?.wake();
      if (notice.type === 'pause') {
        const next = Date.now() + notice.durationMs;
        const extended = next > pausedUntil;
        pausedUntil = Math.max(pausedUntil, next);
        if (extended)
          events.emit('pause', {
            durationMs: notice.durationMs,
            reason: 'store',
          });
      } else if (notice.type === 'resume') {
        pausedUntil = 0;
        events.emit('resume', { reason: 'manual' });
      } else {
        // Every subscribed valve hears each release; coalesce and spread them.
        if (leaseWait) soon();
        return;
      }
      clearWake();
      schedule();
    };
    try {
      const ready = store.subscribe(id, listener);
      if (typeof ready === 'function') unsubscribe = ready;
      // Notifications accelerate wake-ups; admission never waits for them.
      else
        void ready.then((off) => {
          if (closingStore) off();
          else unsubscribe = off;
        }, reportStore);
    } catch (error) {
      reportStore(error);
    }
  }
  return {
    id,
    run: submit,
    wrap:
      (fn, runOptions) =>
      (...args) =>
        submit(() => fn(...args), runOptions),
    wrapFetch,
    observe,
    pause: (value) => {
      const ms = duration(value, id, 'pause');
      return sharedPause(ms, 'manual');
    },
    resume: () =>
      store.resume(id).then(() => {
        pausedUntil = 0;
        delayed?.wake();
        clearWake();
        events.emit('resume', { reason: 'manual' });
        schedule();
      }),
    getLimits: () => {
      if (!config.managed)
        return Promise.reject(
          failure(
            id,
            'INVALID_OPTIONS',
            'getLimits requires limits: "managed".',
          ),
        );
      const issued = ++limitsIssued;
      return call(() => store.managed!.getLimits(context())).then((next) => {
        if (!next)
          throw failure(
            id,
            'INVALID_OPTIONS',
            'Store returned no managed limits.',
          );
        if (accept(next, issued)) relax();
        return next;
      });
    },
    updateLimits: (patch: LimitsPatch, updateOptions?: UpdateLimitsOptions) => {
      try {
        if (!config.managed)
          throw failure(
            id,
            'INVALID_OPTIONS',
            'updateLimits requires limits: "managed". Immutable limits change only through a coordinated migration.',
          );
        if (
          updateOptions !== undefined &&
          (!updateOptions ||
            typeof updateOptions !== 'object' ||
            Array.isArray(updateOptions))
        )
          invalid(
            id,
            'updateLimits options must be an object',
            updateOptions,
            'Pass { expect }',
          );
        checkPatch(id, rules, patch);
        if (updateOptions?.expect !== undefined)
          checkPatch(id, rules, updateOptions.expect, 'limits expect');
      } catch (error) {
        return Promise.reject(error);
      }
      const issued = ++limitsIssued;
      return call(() =>
        store.managed!.updateLimits({
          ...context(),
          patch,
          ...(updateOptions?.expect === undefined
            ? {}
            : { expect: updateOptions.expect }),
        }),
      ).then((next) => {
        if (accept(next, issued)) relax();
        return next;
      });
    },
    stats: () => ({
      queued: waiting.size - reserved,
      running,
      pausedUntil: pausedUntil > Date.now() ? pausedUntil : null,
      totals: { ...totals },
    }),
    on: events.on,
    idle: () =>
      new Promise((resolve) => {
        if (!waiting.size && !running && !retrying) queueMicrotask(resolve);
        else idleResolvers.push(resolve);
      }),
    close,
    // Node 20 releases before 20.4 only define the registered symbol.
    [(Symbol.asyncDispose ??
      Symbol.for('nodejs.asyncDispose')) as typeof Symbol.asyncDispose]: () =>
      close(),
  };
}
