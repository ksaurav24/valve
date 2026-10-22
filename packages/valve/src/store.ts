// Atomic shared budget contract for stores.

/** A rule after validation, in the form stores receive.
 * @example const rule: NormalizedRule = { algorithm: 'gcra', limit: 10, intervalMs: 1000, burst: 1, key: 'gcra:1000' };
 */
export interface NormalizedRule {
  readonly name?: string;
  readonly scope?: string;
  readonly algorithm: 'gcra' | 'fixed-window';
  readonly limit: number;
  readonly intervalMs: number;
  /** Always set. `1` for fixed window rules. */
  readonly burst: number;
  /** Stable rule key: `named:${name}` when named, otherwise `${algorithm}:${intervalMs}`. */
  readonly key: string;
}

/** One request for grants.
 * @example const request: AcquireRequest = { id: 'api', rules: [], costs: [1] };
 */
export interface AcquireRequest {
  /** Valve id. */
  readonly id: string;
  /** Rules to check. Empty for a concurrency-only valve. */
  readonly rules: readonly NormalizedRule[];
  /** Costs of the jobs at the head of the queue, in order. Never empty. */
  readonly costs: readonly number[];
  /** Global concurrency slots requested atomically with the rate budget. */
  readonly lease?: {
    readonly limit: number;
    readonly ttlMs: number;
    readonly owner: string;
  };
}

/** The store's answer.
 * @example const result: AcquireResult = { granted: 1, retryAfterMs: 0, pausedMs: 0 };
 */
export interface AcquireResult {
  /** Jobs granted, counted from the start of `costs`. 0 or more. */
  readonly granted: number;
  /** When `granted < costs.length` and not paused: ms until the next job could be granted. Otherwise 0. */
  readonly retryAfterMs: number;
  /** Ms left on an active pause, or 0. When above 0, `granted` is 0. */
  readonly pausedMs: number;
  /** One unique slot token per grant when lease was requested. */
  readonly leases?: readonly string[];
  /** With a lease request: whether a full lease set, rather than a rate rule, denied the first ungranted job. Optional for custom stores. */
  readonly leaseBlocked?: boolean;
}

/** A store change that should wake waiting valves.
 * @example const notice: StoreNotification = { type: 'resume' };
 */
export type StoreNotification =
  | { readonly type: 'pause'; readonly durationMs: number }
  | { readonly type: 'resume' | 'release' }
  /** Managed limits committed `version`; `relaxed` when any limit or burst increased. */
  | {
      readonly type: 'limits';
      readonly version: string;
      readonly relaxed: boolean;
    };

/**
 * Where a valve keeps its shared budget. Implement this to add a backend.
 * All time math must use the store's own clock.
 * @example const store: Store = memoryStore();
 */
export interface Store {
  /** Short name for messages, for example `"memory"` or `"redis"`. */
  readonly kind: string;
  /** Atomically checks the pause and every rule, then grants a prefix of `costs`. */
  acquire(request: AcquireRequest): Promise<AcquireResult>;
  /** Optional synchronous version, used on the hot path when present. */
  acquireSync?(request: AcquireRequest): AcquireResult;
  /** Atomic all-or-none admission per job; denials do not block later jobs. */
  acquireScoped?(request: ScopedAcquireRequest): Promise<ScopedAcquireResult>;
  /** Optional synchronous scoped path. */
  acquireScopedSync?(request: ScopedAcquireRequest): ScopedAcquireResult;
  /** Extends the pause to at least `durationMs` from now. */
  pause(id: string, durationMs: number): Promise<void>;
  /** Removes the pause. */
  resume(id: string): Promise<void>;
  /** Release global concurrency slot tokens on job settlement. */
  release?(id: string, leases: readonly string[]): Promise<void>;
  /** Renew existing, unexpired slots. False means at least one slot was lost. Never resurrects expired slots. */
  renew?(
    id: string,
    leases: readonly string[],
    ttlMs: number,
  ): Promise<boolean>;
  /** Subscribe to shared pause, resume, slot-release, and managed-limit notices. Returns an unsubscribe function. */
  subscribe?(
    id: string,
    listener: (notice: StoreNotification) => void,
  ): (() => void) | Promise<() => void>;
  /** Frees resources owned by the store. Never closes user provided clients. */
  close(): Promise<void>;
  /** Managed limits support. Required by `limits: 'managed'`; see {@link ManagedStore}. */
  readonly managed?: ManagedStore;
}

/** One rule's authoritative values in a {@link LimitsSnapshot}.
 * @example const rule: LimitsRule = { algorithm: 'gcra', intervalMs: 1000, limit: 10, burst: 1 };
 */
export interface LimitsRule {
  readonly algorithm: 'gcra' | 'fixed-window';
  readonly intervalMs: number;
  readonly limit: number;
  /** Always `1` for fixed window rules. */
  readonly burst: number;
  readonly scope?: string;
}

/** The managed limits a store enforces for one valve id.
 * @example const snapshot: LimitsSnapshot = { version: '1792662950908123.2', revision: 2, rules: {} };
 */
export interface LimitsSnapshot {
  /** Opaque token. Changes on every committed update and when the store registers the limits again. */
  readonly version: string;
  /** Committed updates since registration, starting at 1. Restarts if the store loses its state. */
  readonly revision: number;
  /** Current values by rule name. */
  readonly rules: Readonly<Record<string, LimitsRule>>;
}

/** New absolute values by rule name. Omitted rules and fields keep their current values.
 * @example const patch: LimitsPatch = { throughput: { limit: 200, burst: 20 } };
 */
export type LimitsPatch = Readonly<
  Record<string, { readonly limit?: number; readonly burst?: number }>
>;

/** Context shared by every managed store call.
 * @example const context: ManagedContext = { id: 'api', rules: [] };
 */
export interface ManagedContext {
  readonly id: string;
  /**
   * Named rules. Names, scopes, algorithms and intervals form the structure every
   * worker must share. Their limits and bursts are used only to register limits
   * the store does not have; stores enforce their own authoritative values.
   */
  readonly rules: readonly NormalizedRule[];
  readonly lease?: NonNullable<AcquireRequest['lease']>;
  /** Version the caller last observed. The store returns `limits` when it differs. */
  readonly known?: string;
}

/** Managed static admission.
 * @example const request: ManagedAcquireRequest = { id: 'api', rules: [], costs: [1] };
 */
export interface ManagedAcquireRequest extends ManagedContext {
  readonly costs: readonly number[];
}

/** Managed static admission result.
 * @example const result: ManagedAcquireResult = { granted: 0, retryAfterMs: 0, pausedMs: 0, impossible: true };
 */
export interface ManagedAcquireResult extends AcquireResult {
  /** The first ungranted job costs more than a rule's current capacity and can never start. */
  readonly impossible?: boolean;
  /** Present when the store's version differs from `known`. */
  readonly limits?: LimitsSnapshot;
}

/** Managed scoped admission.
 * @example const request: ManagedScopedRequest = { id: 'api', rules: [], jobs: [] };
 */
export interface ManagedScopedRequest extends ManagedContext {
  readonly jobs: ScopedAcquireRequest['jobs'];
}

/** Managed scoped admission result.
 * @example const result: ManagedScopedResult = { grantedIndexes: [], blocked: [] };
 */
export interface ManagedScopedResult extends ScopedAcquireResult {
  readonly blocked: readonly {
    readonly index: number;
    readonly retryAfterMs: number;
    readonly leaseBlocked?: boolean;
    /** The job costs more than a rule's current capacity and can never start. */
    readonly impossible?: boolean;
  }[];
  readonly limits?: LimitsSnapshot;
}

/** Atomic partial update of managed limits.
 * @example const request: ManagedUpdateRequest = { id: 'api', rules: [], patch: { throughput: { limit: 20 } } };
 */
export interface ManagedUpdateRequest extends ManagedContext {
  readonly patch: LimitsPatch;
  /** Fields that must currently equal these values, or already equal their patched values. */
  readonly expect?: LimitsPatch;
}

/**
 * Store capability for runtime limit updates. Implement all of it or none of it.
 *
 * Every admission must read the authoritative limits inside the same atomic
 * decision and use only those values, never the numbers in `rules`. Reject a
 * different structure, or limits written by an incompatible worker, with
 * `INVALID_OPTIONS` before mutating anything.
 * @example const capability = memoryStore().managed;
 */
export interface ManagedStore {
  readonly version: 1;
  acquire(request: ManagedAcquireRequest): Promise<ManagedAcquireResult>;
  acquireSync?(request: ManagedAcquireRequest): ManagedAcquireResult;
  /** Required for scoped rules. */
  acquireScoped?(request: ManagedScopedRequest): Promise<ManagedScopedResult>;
  acquireScopedSync?(request: ManagedScopedRequest): ManagedScopedResult;
  /** Read the limits, registering them first if the store has none. */
  getLimits(context: ManagedContext): Promise<LimitsSnapshot>;
  /** Apply a patch atomically and notify subscribers. Rejects with `INVALID_OPTIONS` or `LIMITS_CONFLICT`. */
  updateLimits(request: ManagedUpdateRequest): Promise<LimitsSnapshot>;
}

/** Bounded multi-identity admission. With immutable limits, all jobs use the same fixed policy. */
export interface ScopedAcquireRequest {
  readonly id: string;
  readonly rules: readonly NormalizedRule[];
  readonly jobs: readonly {
    readonly cost: number;
    readonly scopes: Readonly<Record<string, string>>;
  }[];
  readonly lease?: AcquireRequest['lease'];
}

/** Zero-based job indexes partitioned into grants and denials. */
export interface ScopedAcquireResult {
  readonly grantedIndexes: readonly number[];
  /** Ms left on an active pause, or 0. When above 0, every job is blocked. Optional for custom stores. */
  readonly pausedMs?: number;
  readonly blocked: readonly {
    readonly index: number;
    readonly retryAfterMs: number;
    /** With a lease request: whether the lease set set the retry hint. Optional for custom stores. */
    readonly leaseBlocked?: boolean;
  }[];
  readonly leases?: readonly {
    readonly index: number;
    readonly token: string;
  }[];
}
