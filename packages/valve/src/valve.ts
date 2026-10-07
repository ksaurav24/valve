// Valve scheduler, shared pauses, lifecycle, and provider-aware fetch retries.
import { duration, integer } from './duration.js';
import { emitter } from './emitter.js';
import { failure, invalid } from './errors.js';
import type { ValveErrorCode } from './errors.js';
import { defaultFeedback } from './headers/index.js';
import { header } from './headers/parse.js';
import type { ResponseLike } from './headers/types.js';
import { memoryStore } from './memory-store.js';
import { JobQueue } from './queue.js';
import { normalize } from './rules.js';
import type { AcquireResult } from './store.js';
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
  location: 'queue' | 'acquire' | null;
}

/** Create a named outbound queue with shared rate rules and local concurrency.
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
      if (options.store) closeResolve();
      else
        void store.close().then(closeResolve, (error) => {
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
    totals[ok ? 'succeeded' : 'failed']++;
    if (ok) job.resolve(result);
    else job.reject(result);
    finishIdle();
    schedule();
  }
  function start(job: Job) {
    if (job.state !== 'queued') return;
    if (job.deadline <= Date.now()) {
      rejectJob(
        job,
        'MAX_WAIT_EXCEEDED',
        `job waited longer than maxWait ${job.waitMs}ms.`,
      );
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
      let result: unknown;
      try {
        result = job.fn({ signal: job.options.signal });
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
  function handle(heads: Job[], result: AcquireResult) {
    const now = Date.now();
    storeFailures = 0;
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
      if (i < result.granted) start(heads[i]!);
      else enqueueAgain(heads[i]!);
    }
    if (result.granted < heads.length)
      arm(now + Math.max(1, result.retryAfterMs) + jitter(result.retryAfterMs));
    else if (waiting.size) schedule();
    finishIdle();
  }
  function storeError(heads: Job[], error: unknown) {
    reportStore(error);
    if (config.policy === 'open') {
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
      for (const job of heads) enqueueAgain(job);
      const delay = Math.min(5000, 100 * 2 ** Math.min(storeFailures++, 6));
      arm(Date.now() + delay + jitter(delay));
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
    if (wakeAt > now && wakeAt !== Infinity) return;
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
    const request = { id, rules, costs };
    if (store.acquireSync) {
      try {
        handle(live, store.acquireSync(request));
      } catch (error) {
        storeError(live, error);
      }
      return;
    }
    inFlight = true;
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
        handle(live, value);
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
    if (!Number.isSafeInteger(retries) || retries < 0)
      invalid(
        id,
        'retries must be a nonnegative integer',
        retries,
        'Use zero to disable retries',
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
      const attempts = stream ? 0 : retries;
      const cost =
        typeof fetchOptions.cost === 'function'
          ? fetchOptions.cost(...args)
          : fetchOptions.cost;
      const priority =
        typeof fetchOptions.priority === 'function'
          ? fetchOptions.priority(...args)
          : fetchOptions.priority;
      const signal = init?.signal ?? request?.signal;
      const originalSeq = seq++;
      const runOptions: RunOptions<ResponseLike> = {
        ...(cost === undefined ? {} : { cost }),
        ...(priority === undefined ? {} : { priority }),
        ...(signal == null ? {} : { signal }),
        ...(fetchOptions.maxWait === undefined
          ? {}
          : { maxWait: fetchOptions.maxWait }),
      };
      for (let attempt = 0; ; attempt++) {
        const callArgs = [...args] as Parameters<F>;
        if (request?.body && attempts > 0)
          (callArgs as unknown[])[0] = request.clone();
        const response = await submit(
          () =>
            Promise.resolve(impl(...(callArgs as never[]))).then((res) => {
              observe(res);
              return res;
            }),
          runOptions,
          originalSeq,
        );
        if (
          attempt >= attempts ||
          (response.status !== 429 &&
            !(
              response.status === 503 &&
              header(response.headers, 'retry-after') !== undefined
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
