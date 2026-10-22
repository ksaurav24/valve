// Public queue, job, rule, and lifecycle types.
import type { LimitsPatch, LimitsSnapshot, Store } from './store.js';
import type { Feedback, ResponseLike } from './headers/types.js';
import type { ValveErrorCode } from './errors.js';

/**
 * A length of time.
 *
 * A number means milliseconds. A string must end in one of the units
 * `ms`, `s`, `m`, `h`. Decimals are allowed, for example `"1.5s"`.
 * Negative values, `NaN`, `Infinity` and unknown units are rejected with
 * `ValveError` code `INVALID_OPTIONS`.
 *
 * @example
 * const a: Duration = 250;    // 250 ms
 * const b: Duration = "10s";  // 10000 ms
 * const c: Duration = "1h";   // 3600000 ms
 */
export type Duration =
  number | `${number}ms` | `${number}s` | `${number}m` | `${number}h`;

/**
 * One rate limit that a valve enforces.
 *
 * A valve may enforce several rules, for example 10 per second and 5000
 * per hour. A job starts only when every rule allows it.
 *
 * GCRA guarantee: total started cost in any window of length `interval`
 * is at most `limit + burst - 1`. With the default `burst: 1` that is
 * exactly `limit`, spread evenly.
 *
 * Fixed window guarantee: at most `limit` per aligned window. Two
 * neighboring windows can together admit up to `2 * limit` in a span of
 * `interval`.
 *
 * Unnamed rules in one valve may not share the same `algorithm` and `interval`.
 *
 * @example
 * // HubSpot private app on Professional: 190 requests per 10 seconds
 * const rule: RateRule = { limit: 190, interval: "10s" };
 *
 * @example
 * // Up to 20 back to back, averaging 10 per second
 * const bursty: RateRule = { limit: 10, interval: "1s", burst: 20 };
 */
export interface RateRule {
  /** Stable rule identity. Required for scoped rules; unique within this Valve. */
  name?: string;
  /** Named identity dimension supplied by each job through scopes. */
  scope?: string;
  /** Cost units allowed per `interval`. Positive integer. */
  limit: number;
  /** Window length. At least 1 ms. */
  interval: Duration;
  /**
   * How many cost units may start back to back before spacing applies.
   * Used by `"gcra"` only. Positive integer. Default `1`.
   *
   * A job whose `cost` is greater than `burst` can never start under
   * GCRA, so `run` rejects it with `COST_EXCEEDS_LIMIT`.
   */
  burst?: number;
  /** Algorithm. Default `"gcra"`. */
  algorithm?: 'gcra' | 'fixed-window';
}

/** What a valve does when its store throws or times out. Configuration failures
 * (`INVALID_OPTIONS`) always reject affected jobs under every policy.
 * @example const policy: StoreErrorPolicy = 'wait';
 */
export type StoreErrorPolicy =
  /** Keep jobs queued and retry the store with backoff until each job's `maxWait`. Safe default. */
  | 'wait'
  /** Run jobs without the store's rate rules while it is down. Local concurrency still applies. */
  | 'open'
  /** Reject the affected jobs with `STORE_UNAVAILABLE`. */
  | 'throw';

/** Shared or per-valve concurrency configuration.
 * @example const concurrency: ConcurrencyOptions = { limit: 5, scope: 'global', leaseTtl: '30s' };
 */
export interface ConcurrencyOptions {
  /** Positive integer maximum number of active jobs. */
  limit: number;
  /** Defaults to local. Global uses store leases shared by valve id. */
  scope?: 'local' | 'global';
  /** Global lease duration, renewed every third of this interval. Default 30s, minimum 30ms. */
  leaseTtl?: Duration;
}

/**
 * Options for {@link createValve}.
 *
 * At least one of `rate` or `concurrency` is required.
 * @example const options: ValveOptions = { id: 'api', concurrency: 2 };
 */
export interface ValveOptions {
  /**
   * Name of the shared budget. Valves with the same `id` and the same
   * store share matching rate rules and one feedback cooldown. Match the
   * provider's quota scope: credential, account, endpoint, resource, or model.
   * Use separate ids for independent quotas, for example
   * `"partner:credential-42:endpoint-search"`. Use non-secret identifiers.
   *
   * 1 to 200 characters. Must not contain `{` or `}`.
   */
  id: string;
  /** One rule or a list of rules. */
  rate?: RateRule | readonly RateRule[];
  /**
   * A number limits jobs per valve instance. Objects select local or global
   * scope. Global requires a store with release and renew. Default Infinity.
   */
  concurrency?: number | ConcurrencyOptions;
  /**
   * Where the shared budget lives. Default: a new private memory store,
   * which shares nothing with other processes.
   */
  store?: Store;
  /**
   * Max jobs waiting in this process, not counting running jobs.
   * Default `Infinity`. When full, `run` rejects with `QUEUE_FULL`.
   */
  maxQueue?: number;
  /**
   * Default max time a job may wait in the queue before it is rejected
   * with `MAX_WAIT_EXCEEDED`. Default: no limit. Does not limit how long
   * the job runs once started. `0` runs a job only if its first admission
   * attempt is granted. With an asynchronous store, a zero-wait job queued
   * behind an in-flight store call waits for the valve to send another
   * batch. It rejects without an attempt if the valve does not send one
   * (after a rate denial, a pause, a store outage, or with local concurrency
   * full) or if higher-priority work submitted meanwhile takes its place.
   */
  maxWait?: Duration;
  /**
   * Reads provider responses passed to `observe`, `wrapFetch`, or the
   * `observe` run option. Default {@link defaultFeedback}. `false` turns
   * header reading off (429 backoff still applies).
   */
  feedback?: Feedback | false;
  /**
   * Upper bound for any single pause caused by feedback or backoff.
   * Protects against bad or misread headers. Default `"15m"`.
   */
  maxPause?: Duration;
  /**
   * Backoff used when a 429 arrives with no usable header. Doubles per
   * consecutive 429, resets after a non 429 response.
   * Default `{ base: "1s", max: "30s" }`.
   */
  backoff?: { base?: Duration; max?: Duration };
  /** What to do when the store fails. Default `"wait"`. */
  onStoreError?: StoreErrorPolicy;
  /**
   * Whether rule limits can change at runtime. Default `"immutable"`: every
   * worker sharing the id must use identical rules, and the store rejects any
   * difference with `INVALID_OPTIONS`.
   *
   * `"managed"` stores authoritative limits in the store. Every rule must have
   * a `name`. The `limit` and GCRA `burst` values here only seed an id the store
   * does not know yet; afterwards the store's values apply to every worker and
   * {@link Valve.updateLimits} changes them. Names, scopes, algorithms,
   * intervals, and global concurrency stay fixed, as in immutable mode.
   * Requires a store with managed support, such as `memoryStore` or `redisStore`.
   */
  limits?: 'immutable' | 'managed';
  /**
   * Advanced. Max jobs asked of the store in one call. Higher values mean
   * fewer round trips under load but coarser fairness between processes.
   * Positive integer. Default `32`. Scoped configurations allow at most `128`.
   */
  batch?: number;
}

/** Options for {@link Valve.updateLimits}.
 * @example const options: UpdateLimitsOptions = { expect: { throughput: { limit: 100 } } };
 */
export interface UpdateLimitsOptions {
  /**
   * Commit only if each listed field currently has this value, or already has
   * its patched value, so retrying after an unknown outcome succeeds. Otherwise
   * nothing changes and the promise rejects with `LIMITS_CONFLICT`.
   */
  expect?: LimitsPatch;
}

/** Options for a single job.
 * @example const options: RunOptions = { cost: 1, priority: 10 };
 */
export interface RunOptions<T = unknown> {
  /** Opaque identities for every configured scope dimension. Copied on submission. */
  scopes?: Readonly<Record<string, string>>;
  /** Units this job uses from every rule. Positive integer. Default `1`. */
  cost?: number;
  /** Higher runs first. Integer. Default `0`. Ties run in call order. */
  priority?: number;
  /** Overrides the valve's `maxWait` for this job. */
  maxWait?: Duration;
  /**
   * Cancels the job while it waits. If it is already running, the signal
   * is passed to the job through {@link JobContext} and valve does not
   * interrupt it.
   */
  signal?: AbortSignal;
  /**
   * Maps the job's result to a response that valve should read for
   * feedback. Use it with clients like axios or got.
   *
   * @example
   * await api.run(() => axios.get(url), { observe: (r) => r });
   */
  observe?: (result: T) => ResponseLike | undefined;
}

/** Passed to every job function.
 * @example api.run(({ signal }: JobContext) => fetch(url, { signal }));
 */
export interface JobContext {
  /** The `signal` given in {@link RunOptions}, if any. */
  readonly signal: AbortSignal | undefined;
}

/** Options for {@link Valve.wrapFetch}.
 * @example const options: WrapFetchOptions = { retries: 2 };
 */
export interface WrapFetchOptions<F extends FetchLike = typeof fetch> {
  /**
   * Additional attempts after the initial request, following a 429 or a 503
   * with a valid `Retry-After`. Each retry waits for any shared pause and
   * re-enters the queue at its original position. Integer, `0` or more.
   * Default `2`, permitting up to three total requests. A retry that cannot be
   * queued, because the valve closed without draining or `maxQueue` is full,
   * returns the last response unread instead of rejecting.
   * Only GET, HEAD, OPTIONS, PUT and DELETE retry by default.
   * Requests with a stream passed as `init.body` are never retried.
   * Inherited Request bodies retry only within `maxReplayBodySize`.
   */
  retries?: number;
  /**
   * Allow retries for other methods, including POST and PATCH. Default `false`.
   * Use a dedicated wrapper only after verifying the provider's idempotency
   * contract. An idempotency key alone does not enable retries.
   * Does not override `retries: 0` or either body replay restriction.
   */
  retryUnsafeMethods?: boolean;
  /**
   * Maximum bytes in an inherited Request body eligible for replay. Default
   * `65536` (64 KiB). Integer, `0` or more; Infinity is not allowed. Zero sends
   * Request bodies once without probing. A bounded clone is read inside the
   * admitted job before fetch starts. Bodies exceeding the byte limit or
   * 1024 chunks (including empty chunks) are sent once; the probe
   * can retain up to this limit plus one source chunk and stream prefetch.
   * Does not apply when `init.body` replaces the Request body.
   */
  maxReplayBodySize?: number;
  /** Fixed identities or a resolver called once per logical request, reused across retries. */
  scopes?:
    | Readonly<Record<string, string>>
    | ((...args: Parameters<F>) => Readonly<Record<string, string>>);
  /** Cost per request. A number or a function of the fetch arguments. Default `1`. */
  cost?: number | ((...args: Parameters<F>) => number);
  /** Priority per request. A number or a function of the fetch arguments. Default `0`. */
  priority?: number | ((...args: Parameters<F>) => number);
  /** Max queue wait for each attempt. Defaults to the valve's `maxWait`. */
  maxWait?: Duration;
}

/** Any function shaped like `fetch` that resolves to a response.
 * @example const client: FetchLike = async () => ({ status: 200, headers: {} });
 */
export type FetchLike = (...args: never[]) => Promise<ResponseLike>;

/** A snapshot of a valve in this process.
 * @example const snapshot: ValveStats = api.stats();
 */
export interface ValveStats {
  /** Jobs waiting in this process. */
  readonly queued: number;
  /** Jobs running in this process. */
  readonly running: number;
  /** Local estimate of when the current pause ends, as epoch ms, or `null`. */
  readonly pausedUntil: number | null;
  /** Counters since the valve was created. */
  readonly totals: {
    readonly started: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly rejected: number;
    readonly retried: number;
    readonly storeErrors: number;
  };
}

/** Why a pause began.
 * @example const reason: PauseReason = 'feedback';
 */
export type PauseReason =
  /** `valve.pause()` was called in this process. */
  | 'manual'
  /** A response header asked for it. */
  | 'feedback'
  /** A 429 with no usable header. */
  | 'backoff'
  /** The store reported a pause set by another process. */
  | 'store';

/** Events emitted by a valve. All payloads are plain readonly objects.
 * @example api.on('pause', (event: ValveEventMap['pause']) => console.log(event.durationMs));
 */
export interface ValveEventMap {
  pause: { readonly durationMs: number; readonly reason: PauseReason };
  resume: { readonly reason: 'manual' | 'expired' };
  reject: { readonly code: ValveErrorCode };
  'store-error': { readonly error: unknown; readonly policy: StoreErrorPolicy };
  idle: Record<string, never>;
  warning: { readonly message: string };
  /** Managed limits this process has not seen before, observed in a store reply. */
  limits: LimitsSnapshot;
}

/**
 * A rate limited queue in front of calls to one budget.
 * Create one with {@link createValve}.
 * @example const api: Valve = createValve({ id: 'api', concurrency: 2 });
 */
export interface Valve extends AsyncDisposable {
  /** The `id` given at creation. */
  readonly id: string;

  /**
   * Queues `fn` and runs it when every rule and the concurrency limit
   * allow. Resolves or rejects with whatever `fn` resolves or rejects with.
   *
   * `fn` is never called synchronously inside `run`.
   *
   * @throws never synchronously. The returned promise rejects with
   * `ValveError` codes `INVALID_OPTIONS`, `COST_EXCEEDS_LIMIT`, `QUEUE_FULL`,
   * `MAX_WAIT_EXCEEDED`, `ABORTED`, `CLOSED`, `STORE_UNAVAILABLE`,
   * or with the error thrown by `fn`.
   *
   * @example
   * const user = await github.run(() => octokit.users.getByUsername({ username }));
   *
   * @example
   * // Interactive work first
   * await api.run(() => syncContact(id), { priority: 10 });
   */
  run<R>(
    fn: (ctx: JobContext) => R,
    options?: RunOptions<Awaited<R>>,
  ): Promise<Awaited<R>>;

  /**
   * Returns a function with the same parameters as `fn` whose calls go
   * through this valve.
   *
   * @example
   * const getContact = hubspot.wrap((id: string) => client.crm.contacts.basicApi.getById(id));
   * const contact = await getContact("123");
   */
  wrap<A extends unknown[], R>(
    fn: (...args: A) => R,
    options?: Omit<RunOptions<Awaited<R>>, 'signal'>,
  ): (...args: A) => Promise<Awaited<R>>;

  /**
   * Returns a fetch that goes through this valve, feeds every response
   * to feedback, and retries 429s or 503s with a valid Retry-After after the
   * shared pause. Only idempotent methods retry by default; see
   * {@link WrapFetchOptions.retryUnsafeMethods} to opt in for other methods.
   *
   * @param fetchImpl Defaults to `globalThis.fetch`.
   *
   * @example
   * const fetchGitHub = github.wrapFetch();
   * const res = await fetchGitHub("https://api.github.com/user");
   *
   * @example
   * import { fetch as undiciFetch } from "undici";
   * const limitedFetch = api.wrapFetch(undiciFetch, { retries: 3 });
   */
  wrapFetch<F extends FetchLike = typeof fetch>(
    fetchImpl?: F,
    options?: WrapFetchOptions<F>,
  ): F;

  /**
   * Reads a provider response with this valve's feedback. If it asks for
   * a pause, every process sharing its id and store pauses. Feedback applies
   * to this id; it does not infer provider quota scopes. Safe to call with
   * any response, including successes. Store writes happen in the background.
   *
   * @example
   * const res = await got(url, { throwHttpErrors: false });
   * api.observe({ status: res.statusCode, headers: res.headers });
   */
  observe(response: ResponseLike): void;

  /**
   * Pauses this valve in every process sharing it. A pause only ever
   * extends an existing pause, never shortens it.
   *
   * @throws `INVALID_OPTIONS` for a bad duration.
   * @example
   * await api.pause("30s");
   */
  pause(duration: Duration): Promise<void>;

  /**
   * Ends the current pause in every process sharing this valve.
   * Stores with subscriptions notify other processes immediately. Redis
   * needs a separate subscriber client; otherwise the next acquire notices.
   *
   * @example
   * await api.resume();
   */
  resume(): Promise<void>;

  /**
   * Reads the store's current managed limits. Registers this valve's rules
   * first if the store has no limits for the id.
   *
   * @throws never synchronously. Rejects with `INVALID_OPTIONS` unless the valve
   * uses `limits: "managed"`, or `STORE_UNAVAILABLE` when the store fails.
   * @example
   * const { rules } = await api.getLimits();
   */
  getLimits(): Promise<LimitsSnapshot>;

  /**
   * Atomically changes `limit` and GCRA `burst` of named rules for every
   * worker sharing this id and store. Omitted rules and fields keep their
   * values, so updates of different fields never overwrite each other. The same
   * field is last write wins unless `expect` is given. Patches set absolute
   * values. A patch that changes nothing creates no new version. A retry can
   * overwrite an intervening same-field update; use `expect` when that matters.
   * Running jobs are unaffected; queued jobs use the new limits at
   * their next admission. Spent budget carries over: fixed windows keep their
   * count, and GCRA keeps its outstanding cost units, which drain at the new rate.
   *
   * @throws never synchronously. Rejects with `INVALID_OPTIONS` for unknown
   * rules or fields, values that are not positive integers, a burst on a
   * fixed-window rule, unsafe numeric precision, or an immutable valve; `LIMITS_CONFLICT` when `expect`
   * fails; or `STORE_UNAVAILABLE` when the store fails, in which case the
   * update may or may not have been applied.
   * @example
   * await api.updateLimits({ throughput: { limit: 200, burst: 20 } });
   */
  updateLimits(
    patch: LimitsPatch,
    options?: UpdateLimitsOptions,
  ): Promise<LimitsSnapshot>;

  /**
   * A snapshot for this process. Allocates a new object per call.
   *
   * @example
   * const { queued, running } = api.stats();
   */
  stats(): ValveStats;

  /**
   * Adds an event listener. Returns a function that removes it.
   * Listener errors are caught and reported as `warning` events.
   *
   * @example
   * const off = api.on("pause", (e) => log.warn({ ...e }, "hubspot paused"));
   */
  on<E extends keyof ValveEventMap>(
    event: E,
    listener: (payload: ValveEventMap[E]) => void,
  ): () => void;

  /**
   * Resolves when nothing is queued or running in this process.
   *
   * @example
   * for (const id of ids) void api.run(() => sync(id));
   * await api.idle();
   */
  idle(): Promise<void>;

  /**
   * Stops accepting jobs. New `run` calls reject with `CLOSED`.
   *
   * With `drain: false` (default) queued jobs reject with `CLOSED` and the
   * promise resolves when running jobs finish. With `drain: true` queued
   * jobs still run first, including retries of accepted `wrapFetch` requests.
   * With global concurrency, the promise also waits up to `leaseTtl` for an
   * in-flight store admission and releases any leases it grants. Never closes
   * the user's store client.
   * Calling `close` twice returns the same promise.
   *
   * @example
   * process.on("SIGTERM", () => api.close({ drain: true }));
   *
   * @example
   * await using api = createValve({ id: "x", rate: { limit: 5, interval: "1s" } });
   */
  close(options?: { drain?: boolean }): Promise<void>;
}
