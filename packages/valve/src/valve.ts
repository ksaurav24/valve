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
import type { AcquireResult, ScopedAcquireResult } from './store.js';
import type {
  FetchLike,
  JobContext,
  PauseReason,
  RunOptions,
  Valve,
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
}

/** Create a named outbound queue with shared rate rules and local or leased concurrency.
 * @param options Budget, store, queue, and feedback configuration.
 * @returns A valve that queues functions and wraps HTTP clients.
 * @throws {ValveError} INVALID_OPTIONS for invalid configuration.
 * @example const api = createValve({ id: 'github:app-42', rate: { limit: 5000, interval: '1h' } }); await api.run(() => fetch(url));
 */
export function createValve(options: ValveOptions): Valve {
  const config = normalize(options);
  const { id, rules } = config;
  const store = options.store ?? memoryStore();
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
  let seq = 0;
  let scheduled = false;
  let inFlight = false;
  let closed = false;
  let pausedUntil = 0;
  let consecutive429 = 0;
  let storeFailures = 0;
  let lastStoreEvent = -Infinity;
  let wake: ReturnType<typeof setTimeout> | undefined;
  let wakeAt = Infinity;
  let idleResolvers: (() => void)[] = [];
  let closePromise: Promise<void> | undefined;
  let closeResolve: (() => void) | undefined;
  let closingStore = false;
  let active = false;
  const costs: number[] = [];
  const owner = config.global ? globalThis.crypto.randomUUID() : '';
  let leaseSequence = 0;
  let unsubscribe: (() => void) | undefined;
  let noticeVersion = 0;
  const leases = config.global
    ? leaseManager(store, id, config.leaseTtl, reportStore, () => {
        clearWake();
        schedule();
      })
    : undefined;

  function clearWake() {
    if (wake !== undefined) clearTimeout(wake);
    wake = undefined;
    wakeAt = Infinity;
  }
  function schedule() {
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(pump);
    }
  }
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
  }
  function jitter(ms: number) {
    return Math.random() * Math.min(25, ms * 0.1);
  }
  function cleanup(job: Job) {
    if (job.timer !== undefined) clearTimeout(job.timer);
    job.timer = undefined;
    if (job.abort) job.options.signal?.removeEventListener('abort', job.abort);
    job.abort = undefined;
  }
  function finishIdle() {
    if (waiting.size || running) return;
    clearWake();
    if (active) {
      active = false;
      events.emit('idle', {});
    }
    const resolvers = idleResolvers;
    idleResolvers = [];
    for (const resolve of resolvers) resolve();
    if (closed && closeResolve && !closingStore) {
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
  function rejectJob(
    job: Job,
    code: ValveErrorCode,
    message: string,
    cause?: unknown,
  ) {
    if (job.state !== 'queued') return;
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
  function reportStore(error: unknown) {
    totals.storeErrors++;
    const now = Date.now();
    if (now - lastStoreEvent >= 1000) {
      lastStoreEvent = now;
      events.emit('store-error', { error, policy: config.policy });
    }
  }
  function enqueueAgain(job: Job) {
    if (job.state === 'queued') {
      job.location = 'queue';
      queue.push(job);
    }
  }
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
    schedule();
  }
  function start(job: Job) {
    if (job.state !== 'queued') {
      if (job.lease) leases!.release(job.lease);
      return;
    }
    if (job.deadline <= Date.now()) {
      rejectJob(
        job,
        'MAX_WAIT_EXCEEDED',
        `job waited longer than maxWait ${job.waitMs}ms.`,
      );
      if (job.lease) leases!.release(job.lease);
      return;
    }
    waiting.delete(job);
    cleanup(job);
    job.state = 'running';
    job.location = null;
    running++;
    totals.started++;
    // Jobs always execute in a microtask, including the memory fast path.
    queueMicrotask(() => {
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
  function handle(
    heads: Job[],
    result: AcquireResult,
    acquiredAt = Date.now(),
    version = noticeVersion,
    acquiredTime?: number,
  ) {
    const now = Date.now();
    if (
      config.global &&
      result.granted > 0 &&
      (result.leases?.length !== result.granted ||
        new Set(result.leases).size !== result.granted)
    ) {
      storeError(
        heads,
        new Error('Store returned invalid global lease tokens'),
      );
      return;
    }
    storeFailures = 0;
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
    for (let i = 0; i < heads.length; i++) {
      const job = heads[i]!;
      if (i < result.granted) {
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
    if (result.granted < heads.length && version !== noticeVersion) {
      clearWake();
      schedule();
    } else if (result.granted < heads.length)
      arm(
        now +
          Math.max(
            1,
            config.global
              ? Math.min(50, result.retryAfterMs)
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
  function handleScoped(
    heads: Job[],
    result: ScopedAcquireResult,
    acquiredAt: number,
    version: number,
  ) {
    const indexes = new Set<number>();
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
        new Error('Store returned invalid scoped grants or lease tokens'),
      );
      return;
    }
    storeFailures = 0;
    const now = Date.now();
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
    for (const entry of result.blocked) {
      const job = heads[entry.index]!;
      if (job.state !== 'queued') continue;
      if (version !== noticeVersion) enqueueAgain(job);
      else {
        job.location = 'delayed';
        delayed!.add(
          job,
          now +
            Math.max(
              1,
              config.global
                ? Math.min(50, entry.retryAfterMs)
                : entry.retryAfterMs,
            ),
        );
      }
    }
    arm(delayed!.next);
    if (queue.size) schedule();
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
      for (const job of heads) {
        if (delayed && job.state === 'queued') {
          job.location = 'delayed';
          delayed.add(job, at);
        } else enqueueAgain(job);
      }
      arm(at);
      if (delayed && queue.size) schedule();
    }
    finishIdle();
  }
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
      if (job.deadline <= now)
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
    const request = {
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
    if (config.scoped) {
      const scopedRequest = {
        id,
        rules,
        jobs: live.map((job) => ({ cost: job.cost, scopes: job.scopes! })),
        ...(request.lease ? { lease: request.lease } : {}),
      };
      if (store.acquireScopedSync) {
        try {
          handleScoped(
            live,
            store.acquireScopedSync(scopedRequest),
            acquiredAt,
            version,
          );
        } catch (error) {
          storeError(live, error);
        }
      } else {
        inFlight = true;
        try {
          store.acquireScoped!(scopedRequest).then(
            (value) => {
              inFlight = false;
              handleScoped(live, value, acquiredAt, version);
            },
            (error) => {
              inFlight = false;
              storeError(live, error);
            },
          );
        } catch (error) {
          inFlight = false;
          storeError(live, error);
        }
      }
      return;
    }
    if (store.acquireSync) {
      try {
        handle(live, store.acquireSync(request), acquiredAt, version);
      } catch (error) {
        storeError(live, error);
      }
      return;
    }
    inFlight = true;
    const acquiredTime = config.global ? undefined : performance.now();
    let result: Promise<AcquireResult>;
    try {
      result = store.acquire(request);
    } catch (error) {
      inFlight = false;
      storeError(live, error);
      return;
    }
    result.then(
      (value) => {
        inFlight = false;
        handle(live, value, acquiredAt, version, acquiredTime);
      },
      (error) => {
        inFlight = false;
        storeError(live, error);
      },
    );
  }
  function submit<R>(
    fn: (ctx: JobContext) => R,
    jobOptions: RunOptions<Awaited<R>> = {},
    originalSeq?: number,
  ): Promise<Awaited<R>> {
    return new Promise<Awaited<R>>((resolve, reject) => {
      try {
        if (closed) throw failure(id, 'CLOSED', 'valve is closed.');
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
        for (const rule of rules) {
          const capacity = rule.algorithm === 'gcra' ? rule.burst : rule.limit;
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
        if (waiting.size >= config.maxQueue)
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
        totals.rejected++;
        events.emit('reject', {
          code:
            error instanceof Error && 'code' in error
              ? (error.code as ValveErrorCode)
              : 'INVALID_OPTIONS',
        });
        reject(error);
      }
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
      const cost =
        typeof fetchOptions.cost === 'function'
          ? fetchOptions.cost(...args)
          : fetchOptions.cost;
      const priority =
        typeof fetchOptions.priority === 'function'
          ? fetchOptions.priority(...args)
          : fetchOptions.priority;
      const signal = init?.signal ?? request?.signal;
      const identities =
        typeof fetchOptions.scopes === 'function'
          ? fetchOptions.scopes(...args)
          : fetchOptions.scopes;
      const scopes =
        config.scoped || identities !== undefined
          ? scopeSnapshot(id, config.scopes, identities)
          : undefined;
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
      for (let attempt = 0; ; attempt++) {
        const callArgs = [...args] as Parameters<F>;
        const response = await submit(
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
            return res;
          },
          runOptions,
          originalSeq,
        );
        if (
          attempt >= attempts ||
          (response.status !== 429 &&
            !(
              response.status === 503 &&
              retryAfterMs(response.headers) !== undefined
            ))
        )
          return response;
        const body = (response as Response).body;
        if (body) {
          try {
            await body.cancel();
          } catch {
            /* A body already consumed by the client needs no cleanup. */
          }
        }
        totals.retried++;
      }
    };
    return limited as unknown as F;
  }
  function close(closeOptions: { drain?: boolean } = {}): Promise<void> {
    if (closePromise) return closePromise;
    closed = true;
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
    const listener: Parameters<NonNullable<typeof store.subscribe>>[1] = (
      notice,
    ) => {
      if (closed && closingStore) return;
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
    stats: () => ({
      queued: waiting.size,
      running,
      pausedUntil: pausedUntil > Date.now() ? pausedUntil : null,
      totals: { ...totals },
    }),
    on: events.on,
    idle: () =>
      new Promise((resolve) => {
        if (!waiting.size && !running) queueMicrotask(resolve);
        else idleResolvers.push(resolve);
      }),
    close,
    [Symbol.asyncDispose]: () => close(),
  };
}
