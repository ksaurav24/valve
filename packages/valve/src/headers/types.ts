// Structural provider response and feedback types.

/** Anything with headers that can be read case insensitively, or a plain record.
 * @example const headers: HeadersLike = new Headers({ 'Retry-After': '2' });
 */
export type HeadersLike =
  | { get(name: string): string | null | undefined }
  | Readonly<Record<string, string | readonly string[] | number | undefined>>;

/** The parts of a response valve reads. `fetch` Response objects fit as is.
 * @example const response: ResponseLike = { status: 429, headers: { 'Retry-After': '2' } };
 */
export interface ResponseLike {
  readonly status: number;
  readonly headers: HeadersLike;
}

/** What a feedback function learned from one response. All fields optional.
 * @example const signal: FeedbackSignal = { pauseMs: 2000 };
 */
export interface FeedbackSignal {
  /** Pause every process sharing the valve for this many ms. */
  pauseMs?: number;
  /** Units the provider says remain in its current window. */
  remaining?: number;
  /** Provider window in ms. IETF t is an effective-window hint, not guaranteed replenishment. */
  resetMs?: number;
}

/**
 * Reads one response. Must be pure and fast. Must not read the body.
 * Returns `undefined` when the response says nothing useful.
 * @example const feedback: Feedback = response => response.status === 429 ? { pauseMs: 1000 } : undefined;
 */
export type Feedback = (response: ResponseLike) => FeedbackSignal | undefined;
