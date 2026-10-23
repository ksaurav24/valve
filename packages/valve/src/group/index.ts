// Independent keyed valves on one shared store, with a bounded local cache.
import { duration, integer } from '../duration.js';
import { failure, invalid } from '../errors.js';
import { memoryStore } from '../memory-store.js';
import type { Store } from '../store.js';
import type {
  Duration,
  JobContext,
  RunOptions,
  RateRule,
  Valve,
  ValveEventMap,
  ValveOptions,
  ValveStats,
} from '../types.js';
import { createValve } from '../valve.js';

/** Options a group resolver returns for one key. The group supplies `id` and `store`.
 * @example const tier: ValveGroupKeyOptions = { rate: { name: 'tenant', limit: 10, interval: '1s' }, limits: 'managed' };
 */
export type ValveGroupKeyOptions = Omit<ValveOptions, 'id' | 'store'> & {
  id?: never;
  store?: never;
};

/** Options for {@link createValveGroup}.
 * @example const options: ValveGroupOptions = { id: 'crm:tenants', resolve: () => ({ concurrency: 2 }) };
 */
export interface ValveGroupOptions<K extends string = string> {
  /**
   * Stable namespace shared by every worker. Each key's valve id is
   * `` `${id}:${encodeURIComponent(key)}` ``, so the same key shares one budget
   * across workers and different keys or groups never share one.
   * 1 to 198 characters. Must not contain `{` or `}`. Use non-secret identifiers.
   */
  id: string;
  /**
   * Where every key's budget lives. Default: a new private memory store that
   * the group closes. A store you pass is shared by all keys and never closed.
   */
  store?: Store;
  /**
   * Returns options synchronously on first local use and after eviction, not
   * per job. May run before room is available to read the default maxWait;
   * canceled calls then create no child. Concurrent waiting calls share the
   * snapshot. Return the same rules for a key on every worker. With
   * `limits: "managed"`, its `limit` and `burst` only seed a key the store does
   * not know yet, so stored limits and updates survive eviction. Options are
   * copied when resolved; later changes to the object have no effect.
   * Calls to this group from inside `resolve` reject with `INVALID_OPTIONS`.
   */
  resolve: (key: K) => ValveGroupKeyOptions;
  /**
   * Max valves this process keeps, busy or idle. When full, the least recently
   * used idle valve is closed to make room. If every valve is busy, the call
   * that needs a new one rejects with `QUEUE_FULL`. A call waiting for an evicted
   * valve to close keeps its `signal`, and the wait counts toward its `maxWait`.
   * For `wrapFetch`, whose `maxWait` bounds each attempt, a wait that uses the
   * whole limit rejects, but a shorter one does not shorten later attempts.
   * Positive integer. Default `1000`.
   */
  maxSize?: number;
  /**
   * Max calls waiting for a closing child to free room. Positive integer.
   * Default `1000`. Overflow rejects with `QUEUE_FULL`; independent of each
   * child's `maxQueue`. Aborted or expired calls immediately leave this queue.
   */
  maxPending?: number;
  /**
   * How long a valve stays after its last call settles. Valves that are paused
   * or still have work stay longer. Eviction only frees local memory: budgets,
   * pauses and managed limits stay in the store. Default `"10m"`.
   */
  idleTtl?: Duration;
}

/**
 * One key of a {@link ValveGroup}. Safe to keep: every call holds the key's
 * valve until it settles, and the next call after an eviction gets a new one.
 * Calls reject with `CLOSED` once the group closes.
 * @example const tenant: ValveGroupMember = tenants.get('tenant-42');
 */
export interface ValveGroupMember<K extends string = string> extends Pick<
  Valve,
  | 'run'
  | 'wrap'
  | 'wrapFetch'
  | 'observe'
  | 'pause'
  | 'resume'
  | 'getLimits'
  | 'updateLimits'
> {
  /** The key given to {@link ValveGroup.get}. */
  readonly key: K;
  /** The valve id the key maps to in the store. */
  readonly id: string;
  /** Stats of the key's valve in this process, or `undefined` when it has none. */
  stats(): ValveStats | undefined;
}

/** Local size of a {@link ValveGroup}.
 * @example const { size, active } = tenants.stats();
 */
export interface ValveGroupStats {
  /** Valves this process keeps, at most `maxSize`. */
  readonly size: number;
  /** Valves with a call in progress. */
  readonly active: number;
}

/**
 * Independent valves for many keys, such as tenants, credentials or models.
 * Create one with {@link createValveGroup}.
 * @example const tenants: ValveGroup = createValveGroup({ id: 'crm:tenants', resolve: () => ({ concurrency: 2 }) });
 */
export interface ValveGroup<K extends string = string> extends AsyncDisposable {
  /** The `id` given at creation. */
  readonly id: string;
  /**
   * Queues `fn` on the key's valve. Same as `get(key).run(fn, options)`.
   * @throws never synchronously. Rejects like {@link Valve.run}, with
   * `INVALID_OPTIONS` for an invalid key or resolver result, with `QUEUE_FULL`
   * when the key needs a valve and `maxSize` valves are busy, or with `CLOSED`.
   * @example await tenants.run('tenant-42', () => send(message), { priority: 5 });
   */
  run<R>(
    key: K,
    fn: (ctx: JobContext) => R,
    options?: RunOptions<Awaited<R>>,
  ): Promise<Awaited<R>>;
  /**
   * Returns the key's member. Creates no valve until a call needs one.
   * @throws {ValveError} INVALID_OPTIONS for an empty or non-string key, or
   * one whose valve id would exceed 200 characters.
   * @example await tenants.get('tenant-42').updateLimits({ tenant: { limit: 40 } });
   */
  get(key: K): ValveGroupMember<K>;
  /**
   * Adds a listener for an event of every key's valve, current and future.
   * Returns a function that removes it.
   * @example tenants.on('pause', (event, key) => log.warn({ key, ...event }));
   */
  on<E extends keyof ValveEventMap>(
    event: E,
    listener: (payload: ValveEventMap[E], key: K) => void,
  ): () => void;
  /** Local valve counts. @example const { size } = tenants.stats(); */
  stats(): ValveGroupStats;
  /**
   * Stops creating valves and closes every key's valve with the same `drain`
   * option as {@link Valve.close}, then waits for calls in progress to settle.
   * Closes the store only if the group created it.
   * Calling `close` twice returns the same promise.
   * @example process.on('SIGTERM', () => tenants.close({ drain: true }));
   */
  close(options?: { drain?: boolean }): Promise<void>;
}

// Receives the milliseconds left of the call's maxWait if it waited for room.
type Operation<R> = (valve: Valve, rest: number | undefined) => R;

interface Config {
  options: ValveGroupKeyOptions;
  maxWait: number | undefined;
}

interface Waiter {
  key: string;
  // Options resolved while waiting, used if this call creates the valve.
  config: Config | undefined;
  check: () => boolean;
  ready: (entry: Entry) => void;
  fail: (error: unknown) => void;
}

interface Entry {
  key: string;
  valve: Valve;
  refs: number;
  used: number;
  closing?: Promise<void>;
  // The key's default maxWait in ms, applied to time spent waiting for room.
  maxWait: number | undefined;
}

/** Create independent valves keyed by tenant, credential, endpoint or model.
 * Keys never share budgets, pauses or concurrency. The same key on every worker
 * shares one budget in the store.
 * @param options Namespace, store, per-key resolver and cache bounds.
 * @returns A group that runs jobs on each key's valve.
 * @throws {ValveError} INVALID_OPTIONS for invalid configuration.
 * @example
 * const tenants = createValveGroup({
 *   id: 'crm:tenants',
 *   store,
 *   resolve: (tenant) => ({ rate: { name: 'tenant', limit: 10, interval: '1s' }, limits: 'managed' }),
 * });
 * await tenants.run('tenant-42', () => send(message));
 */
export function createValveGroup<K extends string = string>(
  options: ValveGroupOptions<K>,
): ValveGroup<K> {
  const id = options?.id;
  if (
    typeof id !== 'string' ||
    id.length < 1 ||
    id.length > 198 ||
    /[{}]/.test(id)
  )
    invalid(
      typeof id === 'string' ? id : undefined,
      'group id must be a string of 1 to 198 characters without braces',
      id,
      'Use a stable namespace such as crm:tenants',
    );
  const resolve = options.resolve;
  if (typeof resolve !== 'function')
    invalid(
      id,
      'resolve must be a function',
      resolve,
      'Return options per key',
    );
  const maxSize = integer(options.maxSize ?? 1000, id, 'maxSize');
  const maxPending = integer(options.maxPending ?? 1000, id, 'maxPending');
  const ttl = duration(options.idleTtl ?? '10m', id, 'idleTtl');
  const owned = !options.store;
  const store = options.store ?? memoryStore();
  // Insertion order is last release order, so the first idle entry is least recently used.
  const entries = new Map<string, Entry>();
  // Calls waiting for room in call order, bounded by maxPending.
  const waiters = new Set<Waiter>();
  const listeners = new Map<
    keyof ValveEventMap,
    Set<(payload: never, key: K) => void>
  >();
  let active = 0;
  let pending = 0;
  let drained: (() => void) | undefined;
  let sweepTimer: ReturnType<typeof setTimeout> | undefined;
  let closePromise: Promise<void> | undefined;
  let resolving = false;

  /** Valve id for a key; encoding keeps `:` out of keys, so ids never collide. */
  function childId(key: unknown) {
    let encoded;
    try {
      if (typeof key === 'string' && key) encoded = encodeURIComponent(key);
    } catch {
      // Lone surrogates have no encoding.
    }
    const child = `${id}:${encoded}`;
    if (encoded === undefined || child.length > 200)
      invalid(
        id,
        'key must be a nonempty string whose valve id fits 200 characters',
        typeof key === 'string' ? `${key.length} characters` : key,
        'Use a short opaque identifier, or a hash of a longer one',
      );
    return child;
  }
  /** Call each listener on its own, reporting throws as warnings like Valve.on. */
  function emit(event: keyof ValveEventMap, payload: unknown, key: K) {
    for (const listener of [...(listeners.get(event) ?? [])])
      try {
        listener(payload as never, key);
      } catch (error) {
        if (event !== 'warning')
          emit(
            'warning',
            { message: `Listener for ${event} threw: ${String(error)}` },
            key,
          );
      }
  }
  function forward(key: K, valve: Valve, event: keyof ValveEventMap) {
    valve.on(event, (payload) => emit(event, payload, key));
  }
  const closed = () => failure(id, 'CLOSED', 'group is closed.');
  function check() {
    if (closePromise) throw closed();
    if (resolving)
      throw failure(
        id,
        'INVALID_OPTIONS',
        'Configuration must not call this group.',
      );
  }
  /** Snapshot caller configuration before waiting; getters cannot reenter. */
  function read<T>(fn: () => T): T {
    check();
    resolving = true;
    try {
      return fn();
    } finally {
      resolving = false;
    }
  }
  /** Read the documented dictionary fields, including prototype accessors. */
  function copyOptions<T extends object>(
    options: T,
    keys: readonly (keyof T)[],
  ): T {
    if (
      !options ||
      (typeof options !== 'object' && typeof options !== 'function')
    )
      return options;
    const copy: Partial<T> = {};
    for (const key of keys) {
      const value = options[key];
      if (value !== undefined) copy[key] = value;
    }
    // Callers list all relevant fields; Valve still validates their values.
    return copy as T;
  }
  function copyScopes<T>(scopes: T): T {
    return scopes && typeof scopes === 'object' && !Array.isArray(scopes)
      ? { ...scopes }
      : scopes;
  }
  /**
   * Read and copy the key's options once. Calls to this group while it runs, or
   * while createValve reads the copy, would duplicate a key or overrun maxSize.
   */
  function configure(key: K): Config {
    const child = childId(key);
    resolving = true;
    try {
      const resolved = resolve(key);
      if (
        !resolved ||
        typeof resolved !== 'object' ||
        'then' in resolved ||
        'id' in resolved ||
        'store' in resolved
      )
        invalid(
          child,
          'resolve must synchronously return options without id or store',
          resolved,
          'The group derives the id and shares its store',
        );
      const copy = copyOptions(resolved, [
        'rate',
        'concurrency',
        'maxQueue',
        'maxWait',
        'feedback',
        'maxPause',
        'backoff',
        'onStoreError',
        'limits',
        'batch',
      ]);
      // Snapshot nested configuration before a wait can expose it to mutation.
      const rule = (value: RateRule) =>
        copyOptions(value, [
          'name',
          'scope',
          'limit',
          'interval',
          'burst',
          'algorithm',
        ]);
      if (copy.rate)
        copy.rate = Array.isArray(copy.rate)
          ? copy.rate.map(rule)
          : rule(copy.rate as RateRule);
      if (copy.concurrency && typeof copy.concurrency === 'object')
        copy.concurrency = copyOptions(copy.concurrency, [
          'limit',
          'scope',
          'leaseTtl',
        ]);
      if (copy.backoff)
        copy.backoff = copyOptions(copy.backoff, ['base', 'max']);
      return {
        options: copy,
        maxWait:
          copy.maxWait === undefined
            ? undefined
            : duration(copy.maxWait, child, 'maxWait'),
      };
    } finally {
      resolving = false;
    }
  }
  function create(key: K, config = configure(key)) {
    if (closePromise) throw closed();
    resolving = true;
    try {
      const valve = createValve({ ...config.options, id: childId(key), store });
      for (const event of listeners.keys()) forward(key, valve, event);
      const entry: Entry = {
        key,
        valve,
        refs: 0,
        used: 0,
        maxWait: config.maxWait,
      };
      entries.set(key, entry);
      return entry;
    } finally {
      resolving = false;
    }
  }
  /** Busy entries are pinned; paused ones keep their local pause and backoff. */
  function evictable(entry: Entry) {
    if (entry.refs || entry.closing) return false;
    const { queued, running, pausedUntil } = entry.valve.stats();
    return !queued && !running && pausedUntil === null;
  }
  /** Later calls for the key wait for the close, so a key never has two valves. */
  function evict(entry: Entry) {
    return (entry.closing = entry.valve.close({ drain: true }).finally(() => {
      if (entries.get(entry.key) === entry) entries.delete(entry.key);
      admit();
    }));
  }
  function sweep() {
    sweepTimer = undefined;
    const now = Date.now();
    let next = Infinity;
    for (const entry of entries.values()) {
      if (entry.refs || entry.closing) continue;
      if (entry.used + ttl > now) {
        next = Math.min(next, entry.used + ttl);
        break;
      }
      if (evictable(entry)) void evict(entry);
      else next = Math.min(next, now + Math.max(ttl, 1000));
    }
    if (next < Infinity) arm(next);
  }
  function arm(at: number) {
    sweepTimer = setTimeout(
      sweep,
      Math.min(2147483647, Math.max(0, at - Date.now())),
    );
    // Eviction is cleanup only; it must not keep the process alive.
    (sweepTimer as { unref?: () => void }).unref?.();
  }
  function pin(entry: Entry) {
    if (!entry.refs++) active++;
    pending++;
    return entry;
  }
  function release(entry: Entry) {
    if (!--entry.refs) {
      active--;
      entry.used = Date.now();
      if (entries.get(entry.key) === entry) {
        entries.delete(entry.key);
        entries.set(entry.key, entry);
      }
      if (!closePromise && !sweepTimer) arm(entry.used + ttl);
      // An idle valve can make room for a waiting call.
      if (waiters.size) admit();
    }
    if (!--pending) drained?.();
  }
  /**
   * Pin the key's valve, creating one or evicting an idle one to make room.
   * @returns undefined when the call must wait for a valve to close.
   * @throws {ValveError} QUEUE_FULL when every valve is busy.
   */
  function claim(key: K, config?: Config) {
    const entry = entries.get(key);
    if (entry) return entry.closing ? undefined : pin(entry);
    if (entries.size < maxSize) return pin(create(key, config));
    for (const other of entries.values())
      if (other.closing || evictable(other)) {
        if (!other.closing) void evict(other);
        return undefined;
      }
    throw failure(id, 'QUEUE_FULL', 'maxSize reached: no idle valve.');
  }
  /** Retry waiting calls in call order, never letting a key's later call pass an earlier one. */
  function admit() {
    for (const waiter of [...waiters]) {
      if (!waiters.has(waiter) || !waiter.check()) continue;
      let entry;
      try {
        entry = claim(waiter.key as K, waiter.config);
      } catch (error) {
        waiter.fail(error);
        continue;
      }
      if (entry) waiter.ready(entry);
    }
  }
  /** Run one operation on the key's pinned valve and unpin it once it settles. */
  function settle<R>(
    entry: Entry,
    operation: Operation<R>,
    rest: number | undefined,
  ) {
    let result;
    try {
      result = Promise.resolve(operation(entry.valve, rest));
    } catch (error) {
      result = Promise.reject(error);
    }
    return result.then(
      (value) => {
        release(entry);
        return value;
      },
      (error: unknown) => {
        release(entry);
        throw error;
      },
    ) as Promise<Awaited<R>>;
  }
  /**
   * Run an operation on the key's valve. A call that waits for room keeps its
   * signal and its maxWait (or the key's default), since the valve has not seen
   * it yet; the operation then receives the milliseconds left. At most maxPending
   * calls wait at once, and a call that gives up never creates a valve.
   */
  function use<R>(
    key: K,
    operation: Operation<R>,
    wait?: { signal?: AbortSignal | undefined; maxWait?: Duration | undefined },
  ): Promise<Awaited<R>> {
    try {
      check();
      const entry = entries.get(key);
      const queued = waiters.size
        ? [...waiters].find((call) => call.key === key)
        : undefined;
      // Valve methods never run jobs synchronously, so a ready valve is called directly.
      if (entry && !entry.closing && !queued)
        return settle(pin(entry), operation, undefined);
      const child = childId(key);
      const own =
        wait?.maxWait === undefined
          ? undefined
          : duration(wait.maxWait, child, 'job maxWait');
      const ready = queued ? undefined : claim(key);
      if (ready) return settle(ready, operation, undefined);
      const config = entries.has(key)
        ? undefined
        : (queued?.config ?? configure(key));
      if (closePromise) throw closed();
      const limit = own ?? config?.maxWait ?? entries.get(key)?.maxWait;
      const signal = wait?.signal;
      const aborted = () =>
        failure(
          child,
          'ABORTED',
          'job was aborted before starting.',
          signal?.reason,
        );
      const expired = () =>
        failure(
          child,
          'MAX_WAIT_EXCEEDED',
          `maxWait ${limit}ms exceeded waiting for room.`,
        );
      if (signal?.aborted) throw aborted();
      // Check after reading all caller properties, just before registration.
      check();
      if (waiters.size >= maxPending)
        throw failure(id, 'QUEUE_FULL', `maxPending ${maxPending} reached.`);
      const deadline = limit === undefined ? undefined : Date.now() + limit;
      return new Promise((done, fail) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const leave = () => {
          waiters.delete(waiter);
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
        };
        const waiter: Waiter = {
          key,
          config,
          check: () => {
            if (deadline === undefined || Date.now() < deadline) return true;
            waiter.fail(expired());
            return false;
          },
          ready: (pinned) => {
            leave();
            const rest =
              deadline === undefined ? undefined : deadline - Date.now();
            if (rest !== undefined && rest <= 0) {
              fail(expired());
              release(pinned);
            } else settle(pinned, operation, rest).then(done, fail);
          },
          fail: (error) => {
            leave();
            fail(error);
          },
        };
        const abort = () => waiter.fail(aborted());
        // Rearm long deadlines past the platform timer maximum.
        const tick = () => {
          const rest = deadline! - Date.now();
          if (rest > 0) timer = setTimeout(tick, Math.min(2147483647, rest));
          else waiter.fail(expired());
        };
        waiters.add(waiter);
        signal?.addEventListener('abort', abort, { once: true });
        if (deadline !== undefined) tick();
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }
  /** Queue a job; time spent waiting for room counts toward its maxWait. */
  async function submit<R>(
    key: K,
    fn: (ctx: JobContext) => R,
    runOptions: RunOptions<Awaited<R>> = {},
  ): Promise<Awaited<R>> {
    runOptions = read(() => {
      const copy = copyOptions(runOptions, [
        'cost',
        'priority',
        'maxWait',
        'signal',
        'observe',
        'scopes',
      ]);
      if (copy.scopes !== undefined) copy.scopes = copyScopes(copy.scopes);
      if (typeof copy.observe === 'function')
        copy.observe = copy.observe.bind(runOptions);
      return copy;
    });
    return use(
      key,
      (valve, rest) =>
        valve.run(
          fn,
          rest === undefined ? runOptions : { ...runOptions, maxWait: rest },
        ),
      runOptions,
    );
  }
  function get(key: K): ValveGroupMember<K> {
    const child = childId(key);
    return {
      key,
      id: child,
      run: (fn, runOptions) => submit(key, fn, runOptions),
      wrap:
        (fn, runOptions) =>
        (...args) =>
          submit(key, () => fn(...args), runOptions),
      wrapFetch: ((fetchImpl, fetchOptions) =>
        async (...args: never[]) => {
          const config = read(() => {
            const options = copyOptions(
              fetchOptions === undefined ? {} : fetchOptions,
              [
                'retries',
                'retryUnsafeMethods',
                'maxReplayBodySize',
                'cost',
                'priority',
                'scopes',
                'maxWait',
              ],
            );
            for (const field of ['cost', 'priority', 'scopes'] as const) {
              const value = options[field];
              if (typeof value === 'function')
                Object.assign(options, {
                  [field]: Reflect.apply(value, undefined, args),
                });
            }
            if (options.scopes !== undefined)
              options.scopes = copyScopes(options.scopes);
            const [request, init] = args as unknown as [
              { signal?: AbortSignal } | undefined,
              { signal?: AbortSignal } | undefined,
            ];
            return { options, signal: init?.signal ?? request?.signal };
          });
          // maxWait bounds every attempt, including retries after a shared
          // pause, so a wait for room can exhaust it but never shortens it.
          return use<unknown>(
            key,
            (valve) => valve.wrapFetch(fetchImpl, config.options)(...args),
            {
              signal: config.signal,
              maxWait: config.options.maxWait,
            },
          );
        }) as Valve['wrapFetch'],
      observe: (response) => {
        use(key, (valve) => valve.observe(response)).catch((error) =>
          emit('warning', { message: `observe failed: ${String(error)}` }, key),
        );
      },
      pause: (value) => use(key, (valve) => valve.pause(value)),
      resume: () => use(key, (valve) => valve.resume()),
      getLimits: () => use(key, (valve) => valve.getLimits()),
      updateLimits: (patch, updateOptions) =>
        use(key, (valve) => valve.updateLimits(patch, updateOptions)),
      stats: () => entries.get(key)?.valve.stats(),
    };
  }
  function close(closeOptions: { drain?: boolean } = {}): Promise<void> {
    if (closePromise) return closePromise;
    let finish!: (closing: Promise<void>) => void;
    // Mark the group closed before child listeners can call back into it.
    closePromise = new Promise((done) => (finish = done));
    clearTimeout(sweepTimer);
    for (const waiter of [...waiters]) waiter.fail(closed());
    const drain = !!closeOptions.drain;
    finish(
      Promise.all(
        [...entries.values()].map(
          (entry) => (entry.closing ??= entry.valve.close({ drain })),
        ),
      )
        .then(() =>
          pending ? new Promise<void>((done) => (drained = done)) : undefined,
        )
        .then(() => {
          entries.clear();
          return owned ? store.close() : undefined;
        }),
    );
    return closePromise;
  }
  return {
    id,
    run: submit,
    get,
    on: (event, listener) => {
      let set = listeners.get(event);
      if (!set) {
        listeners.set(event, (set = new Set()));
        for (const entry of entries.values())
          forward(entry.key as K, entry.valve, event);
      }
      set.add(listener as (payload: never, key: K) => void);
      return () => {
        set.delete(listener as (payload: never, key: K) => void);
      };
    },
    stats: () => ({ size: entries.size, active }),
    close,
    // Node 20 releases before 20.4 only define the registered symbol.
    [(Symbol.asyncDispose ??
      Symbol.for('nodejs.asyncDispose')) as typeof Symbol.asyncDispose]: () =>
      close(),
  };
}
