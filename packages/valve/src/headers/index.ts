// Provider feedback readers that never read or consume response bodies.
import { compound, header, number, reference } from './parse.js';
import type { Feedback, FeedbackSignal } from './types.js';
export type {
  Feedback,
  FeedbackSignal,
  ResponseLike,
  HeadersLike,
} from './types.js';
/** Read Retry-After seconds or HTTP dates on 429 and 503 responses.
 * @returns A pure feedback reader.
 * @example createValve({ id: 'api', concurrency: 2, feedback: retryAfter() });
 */
export function retryAfter(): Feedback {
  return (response) => {
    if (response.status !== 429 && response.status !== 503) return undefined;
    const value = header(response.headers, 'retry-after');
    if (value === undefined) return undefined;
    const seconds = number(value);
    const date = /[a-z]/i.test(value) ? Date.parse(value) : NaN;
    const pauseMs =
      seconds !== undefined
        ? seconds * 1000
        : Number.isFinite(date)
          ? Math.max(0, date - reference(response.headers))
          : undefined;
    return pauseMs !== undefined && Number.isFinite(pauseMs)
      ? { pauseMs }
      : undefined;
  };
}
/** Read RateLimit available quota (r) and optional effective-window seconds (t).
 * Verified against draft-ietf-httpapi-ratelimit-headers-11, sections 4.1.1 and 4.1.2.
 * https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-ratelimit-headers-11#section-4.1
 * The effective window is a quota hint, not a guarantee of full replenishment.
 * Also supports legacy remaining/reset fields.
 * @returns A feedback reader for exhausted quota windows.
 * @example createValve({ id: 'api', concurrency: 2, feedback: ietfRateLimit() });
 */
export function ietfRateLimit(): Feedback {
  return (response) => {
    const field = header(response.headers, 'ratelimit');
    let signal: FeedbackSignal | undefined;
    if (field) {
      for (const item of field.split(/,(?=(?:[^"\\]*"[^"\\]*")*[^"\\]*$)/)) {
        const remaining = number(/(?:^|;)\s*r\s*=\s*([^;\s]+)/.exec(item)?.[1]);
        const window = /(?:^|;)\s*t(?:\s*=\s*([^;\s]*))?(?=;|\s|$)/.exec(item);
        const seconds = number(window?.[1]);
        if (
          remaining === undefined ||
          !Number.isInteger(remaining) ||
          remaining > 999_999_999_999_999 ||
          (window !== null &&
            (seconds === undefined ||
              !Number.isInteger(seconds) ||
              seconds > 999_999_999_999_999))
        )
          continue;
        const resetMs = seconds === undefined ? undefined : seconds * 1000;
        if (
          !signal ||
          (remaining === 0 &&
            (signal.remaining !== 0 || (resetMs ?? 0) > (signal.resetMs ?? 0)))
        )
          signal = {
            remaining,
            ...(resetMs === undefined ? {} : { resetMs }),
          };
      }
    }
    if (signal) return signal;
    const remaining = number(header(response.headers, 'ratelimit-remaining'));
    const seconds = number(header(response.headers, 'ratelimit-reset'));
    if (remaining === undefined && seconds === undefined) return undefined;
    return {
      ...(remaining === undefined ? {} : { remaining }),
      ...(seconds === undefined || !Number.isFinite(seconds * 1000)
        ? {}
        : { resetMs: seconds * 1000 }),
    };
  };
}
/** Options for x-ratelimit readers. @example xRateLimit({ resetUnit: 'epoch-seconds' }); */
export interface XRateLimitOptions {
  /** Remaining header name. Defaults to x-ratelimit-remaining or x-rate-limit-remaining. */ remaining?: string;
  /** Reset header name. Defaults to x-ratelimit-reset or x-rate-limit-reset. */ reset?: string;
  /** Reset encoding. Defaults to auto. */ resetUnit?:
    'auto' | 'seconds' | 'epoch-seconds' | 'epoch-ms' | 'ms' | 'duration';
}
/** Read common x-ratelimit headers and Go-style reset durations.
 * @param options Header names and reset units.
 * @returns A provider feedback reader.
 * @example xRateLimit({ reset: 'x-reset', resetUnit: 'seconds' });
 */
export function xRateLimit(options: XRateLimitOptions = {}): Feedback {
  return (response) => {
    const remaining = number(
      options.remaining
        ? header(response.headers, options.remaining)
        : (header(response.headers, 'x-ratelimit-remaining') ??
            header(response.headers, 'x-rate-limit-remaining')),
    );
    const raw = options.reset
      ? header(response.headers, options.reset)
      : (header(response.headers, 'x-ratelimit-reset') ??
        header(response.headers, 'x-rate-limit-reset'));
    const n = number(raw);
    const unit = options.resetUnit ?? 'auto';
    let resetMs: number | undefined;
    if (unit === 'duration' || (unit === 'auto' && n === undefined))
      resetMs = compound(raw);
    else if (n !== undefined) {
      if (unit === 'epoch-ms' || (unit === 'auto' && n > 1e12))
        resetMs = Math.max(0, n - reference(response.headers));
      else if (unit === 'epoch-seconds' || (unit === 'auto' && n > 1e9))
        resetMs = Math.max(0, n * 1000 - reference(response.headers));
      else resetMs = n * (unit === 'ms' ? 1 : 1000);
    }
    if (remaining === undefined && resetMs === undefined) return undefined;
    return {
      ...(remaining === undefined ? {} : { remaining }),
      ...(resetMs === undefined || !Number.isFinite(resetMs)
        ? {}
        : { resetMs }),
    };
  };
}
/** Combine readers, keeping the longest pause and first remaining/reset values.
 * @param feedbacks Readers in precedence order.
 * @returns A composed feedback reader.
 * @example const feedback = combine(retryAfter(), xRateLimit());
 */
export function combine(...feedbacks: readonly Feedback[]): Feedback {
  return (response) => {
    let result: FeedbackSignal | undefined;
    for (const reader of feedbacks) {
      const next = reader(response);
      if (!next) continue;
      result ??= {};
      if (next.pauseMs !== undefined)
        result.pauseMs = Math.max(result.pauseMs ?? 0, next.pauseMs);
      if (result.remaining === undefined && next.remaining !== undefined)
        result.remaining = next.remaining;
      if (result.resetMs === undefined && next.resetMs !== undefined)
        result.resetMs = next.resetMs;
    }
    return result;
  };
}
// Reader construction only creates closures; unused readers can be removed.
/** Standard Retry-After, IETF, and x-ratelimit feedback.
 * @example createValve({ id: 'api', concurrency: 2, feedback: defaultFeedback });
 */
export const defaultFeedback: Feedback = /* @__PURE__ */ combine(
  /* @__PURE__ */ retryAfter(),
  /* @__PURE__ */ ietfRateLimit(),
  /* @__PURE__ */ xRateLimit(),
);
