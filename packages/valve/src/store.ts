// Atomic shared budget contract for stores.

/** A rule after validation, in the form stores receive.
 * @example const rule: NormalizedRule = { algorithm: 'gcra', limit: 10, intervalMs: 1000, burst: 1, key: 'gcra:1000' };
 */
export interface NormalizedRule {
  readonly algorithm: 'gcra' | 'fixed-window';
  readonly limit: number;
  readonly intervalMs: number;
  /** Always set. `1` for fixed window rules. */
  readonly burst: number;
  /** Stable key part for this rule: `${algorithm}:${intervalMs}`. */
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
}

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
  /** Extends the pause to at least `durationMs` from now. */
  pause(id: string, durationMs: number): Promise<void>;
  /** Removes the pause. */
  resume(id: string): Promise<void>;
  /** Frees resources owned by the store. Never closes user provided clients. */
  close(): Promise<void>;
}
