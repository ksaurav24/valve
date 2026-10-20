// Contract between the worker driver and a limiter library under test.
import type { CallRecord, CellSpec, LibraryId } from '../core/types.ts';

export interface SubmitOptions {
  cost: number;
  priority?: number;
  /** Maximum queue wait (ms) before the job must not start. Libraries without this semantic must not receive it. */
  maxWaitMs?: number;
  signal?: AbortSignal;
  scopes?: Record<string, string>;
}

/** A configured limiter instance inside one worker process. */
export interface Limiter {
  /**
   * Queue `fn` and resolve with its result. Rejections must carry `code` when the library
   * reports a structured reason (`MAX_WAIT_EXCEEDED`, `ABORTED`, `QUEUE_FULL`, ...).
   */
  submit<T>(fn: () => T | Promise<T>, options: SubmitOptions): Promise<T>;
  /** Stop and release resources (connections, timers). Must not reject. */
  close(): Promise<void>;
  /** Library-reported counters, if any. */
  stats?(): Record<string, number>;
  control?(
    action: 'pause' | 'resume' | 'observe',
    durationMs?: number,
  ): Promise<void>;
}

/** Everything an adapter may use; created by the worker. */
export interface AdapterContext {
  cell: CellSpec;
  worker: number;
  instance: number;
  /** Shared quota identity for this trial (same across workers of one arm and rep). */
  quotaId: string;
  /** Key prefix owned by this trial (prefix-mode isolation). */
  keyPrefix: string;
  /** Redis URL for distributed cells, undefined for local cells. */
  redisUrl?: string;
  /** Absolute path of the Valve build's package dir (dist/ inside). */
  valvePackageDir: string;
  /** Correctness instrumentation: Lua log key, or undefined for uninstrumented arms. */
  luaLogKey?: string;
  /** Record a store call (Valve adapter only; competitors may record their Redis calls). */
  onCall(record: CallRecord): void;
  /** Monotonic epoch clock used for all records. */
  now(): number;
}

export interface Adapter {
  id: LibraryId;
  /** Exact package version under test (read from its package.json). */
  version: string;
  /** `true`, or a reason why this cell is N/A for the library. */
  supports(cell: CellSpec): true | string;
  create(ctx: AdapterContext): Promise<Limiter>;
}
