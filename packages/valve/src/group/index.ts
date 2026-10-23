// Independent keyed valves on one shared store, with a bounded local cache.
import { duration, integer } from '../duration.js';
import { failure, invalid } from '../errors.js';
import { memoryStore } from '../memory-store.js';
import type { Store } from '../store.js';
import type {
  Duration,
  JobContext,
  RunOptions,
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
   * Returns the options for one key. Called synchronously each time the key
   * gets a valve in this process: on first use and again after eviction, never
   * per job. Return the same rules for a key on every worker. With
   * `limits: "managed"`, its `limit` and `burst` only seed a key the store does
   * not know yet, so stored limits and updates survive eviction. Options are
   * read when the valve is created; later changes to the object have no effect.
   */
  resolve: (key: K) => ValveGroupKeyOptions;
  /**
   * Max valves this process keeps, busy or idle. When full, the least recently
   * used idle valve is closed to make room. If every valve is busy, the call
   * that needs a new one rejects with `QUEUE_FULL`. Positive integer. Default `1000`.
   */
  maxSize?: number;
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

interface Entry {
  key: string;
  valve: Valve;
  refs: number;
  used: number;
  closing?: Promise<void>;
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
  const ttl = duration(options.idleTtl ?? '10m', id, 'idleTtl');
  const store = options.store ?? memoryStore();
  // Insertion order is last release order, so the first idle entry is least recently used.
  const entries = new Map<string, Entry>();
  // The newest call waiting for each key, which later calls for the key wait behind.
  const waits = new Map<string, Promise<Entry>>();
  const listeners = new Map<
    keyof ValveEventMap,
    Set<(payload: never, key: K) => void>
  >();
  let active = 0;
  let pending = 0;
  let drained: (() => void) | undefined;
  let sweepTimer: ReturnType<typeof setTimeout> | undefined;
  let closePromise: Promise<void> | undefined;

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
  function emit(event: keyof ValveEventMap, payload: unknown, key: K) {
    listeners
      .get(event)
      ?.forEach((listener) => listener(payload as never, key));
  }
  function forward(key: K, valve: Valve, event: keyof ValveEventMap) {
    valve.on(event, (payload) => emit(event, payload, key));
  }
  function create(key: K) {
    const child = childId(key);
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
    const valve = createValve({ ...resolved, id: child, store });
    for (const event of listeners.keys()) forward(key, valve, event);
    const entry: Entry = { key, valve, refs: 0, used: 0 };
    entries.set(key, entry);
    return entry;
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
    }
    if (!--pending) drained?.();
  }
  /**
   * Find, create or make room for the key's valve, pinning it before returning.
   * Synchronous unless the call must wait for a close; waiting calls for a key
   * queue behind each other, so they reach the valve in call order.
   */
  function acquire(key: K, turn?: boolean): Entry | Promise<Entry> {
    if (closePromise) throw failure(id, 'CLOSED', 'group is closed.');
    const entry = entries.get(key);
    // A call whose turn came never waits behind the calls queued after it.
    const queued = turn ? undefined : waits.get(key);
    if (entry && !entry.closing && !queued) return pin(entry);
    let wait = queued ?? entry?.closing;
    if (!wait) {
      childId(key);
      if (entries.size < maxSize) return pin(create(key));
      for (const other of entries.values())
        if (other.closing || evictable(other)) {
          wait = other.closing ?? evict(other);
          break;
        }
      if (!wait)
        throw failure(
          id,
          'QUEUE_FULL',
          `all ${maxSize} valves (maxSize) are busy. Retry later or raise maxSize.`,
        );
    }
    const retry = () => {
      if (waits.get(key) === next) waits.delete(key);
      return acquire(key, true);
    };
    const next: Promise<Entry> = wait.then(retry, retry);
    if (!turn || !waits.has(key)) waits.set(key, next);
    return next;
  }
  /** Run one operation on the key's pinned valve and unpin it once it settles. */
  function settle<R>(entry: Entry, operation: (valve: Valve) => R) {
    let result;
    try {
      result = Promise.resolve(operation(entry.valve));
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
    );
  }
  function use<R>(key: K, operation: (valve: Valve) => R): Promise<Awaited<R>> {
    let ready;
    try {
      ready = acquire(key);
    } catch (error) {
      return Promise.reject(error);
    }
    // Valve methods never run jobs synchronously, so a ready valve is called directly.
    return (
      'then' in ready
        ? ready.then((pinned) => settle(pinned, operation))
        : settle(ready, operation)
    ) as Promise<Awaited<R>>;
  }
  function get(key: K): ValveGroupMember<K> {
    const child = childId(key);
    return {
      key,
      id: child,
      run: (fn, runOptions) => use(key, (valve) => valve.run(fn, runOptions)),
      wrap:
        (fn, runOptions) =>
        (...args) =>
          use(key, (valve) => valve.run(() => fn(...args), runOptions)),
      wrapFetch: ((fetchImpl, fetchOptions) =>
        (...args: never[]) =>
          use(key, (valve) =>
            valve.wrapFetch(fetchImpl, fetchOptions)(...args),
          )) as Valve['wrapFetch'],
      observe: (response) => {
        use(key, (valve) => valve.observe(response)).catch((error) => {
          try {
            emit(
              'warning',
              { message: `observe failed: ${String(error)}` },
              key,
            );
          } catch {
            // Warning listeners that throw have nowhere else to report.
          }
        });
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
    clearTimeout(sweepTimer);
    const drain = !!closeOptions.drain;
    closePromise = Promise.all(
      [...entries.values()].map(
        (entry) => (entry.closing ??= entry.valve.close({ drain })),
      ),
    )
      .then(() =>
        pending ? new Promise<void>((done) => (drained = done)) : undefined,
      )
      .then(() => {
        entries.clear();
        return options.store ? undefined : store.close();
      });
    return closePromise;
  }
  return {
    id,
    run: (key, fn, runOptions) =>
      use(key, (valve) => valve.run(fn, runOptions)),
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
