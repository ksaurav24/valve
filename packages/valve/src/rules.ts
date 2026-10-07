// Synchronous validation of valve options and stable rule normalization.
import { duration, integer } from './duration.js';
import { failure, invalid } from './errors.js';
import type { NormalizedRule } from './store.js';
import type { ValveOptions } from './types.js';
export function normalize(options: ValveOptions) {
  const id = options?.id;
  if (
    typeof id !== 'string' ||
    id.length < 1 ||
    id.length > 200 ||
    /[{}]/.test(id)
  )
    invalid(
      typeof id === 'string' ? id : undefined,
      'id must be a string of 1 to 200 characters without braces',
      id,
      'Include the provider and credential',
    );
  const concurrency = integer(
    options.concurrency ?? Infinity,
    id,
    'concurrency',
    true,
  );
  if (options.rate === undefined && concurrency === Infinity)
    invalid(
      id,
      'rate or finite concurrency is required',
      concurrency,
      'Provide a rate rule or a finite concurrency',
    );
  const raw =
    options.rate === undefined
      ? []
      : Array.isArray(options.rate)
        ? options.rate
        : [options.rate];
  if (options.rate !== undefined && raw.length === 0)
    invalid(
      id,
      'rate must contain at least one rule',
      raw,
      'Provide a rate rule',
    );
  const seen = new Set<string>();
  const rules: NormalizedRule[] = raw.map((rule, i) => {
    if (!rule || typeof rule !== 'object')
      invalid(
        id,
        `rate[${i}] must be an object`,
        rule,
        'Provide limit and interval',
      );
    if (!Number.isSafeInteger(rule.limit) || rule.limit < 1)
      invalid(
        id,
        `rate[${i}].limit must be a positive integer`,
        rule.limit,
        'Use the number of requests the provider allows per interval',
      );
    const intervalMs = duration(rule.interval, id, `rate[${i}].interval`);
    if (intervalMs < 1)
      invalid(
        id,
        `rate[${i}].interval must be at least 1ms`,
        rule.interval,
        'Use an interval of at least 1ms',
      );
    const algorithm = rule.algorithm ?? 'gcra';
    if (algorithm !== 'gcra' && algorithm !== 'fixed-window')
      invalid(
        id,
        `rate[${i}].algorithm is unknown`,
        algorithm,
        'Use gcra or fixed-window',
      );
    const burst = integer(rule.burst ?? 1, id, `rate[${i}].burst`);
    const key = `${algorithm}:${intervalMs}`;
    if (seen.has(key))
      throw failure(
        id,
        'INVALID_OPTIONS',
        `two rules use algorithm ${algorithm} with interval ${intervalMs}ms. Merge them into one rule.`,
      );
    seen.add(key);
    return {
      algorithm,
      limit: rule.limit,
      intervalMs,
      burst: algorithm === 'gcra' ? burst : 1,
      key,
    };
  });
  const maxWait =
    options.maxWait === undefined
      ? Infinity
      : duration(options.maxWait, id, 'maxWait');
  const maxPause = duration(options.maxPause ?? '15m', id, 'maxPause');
  const backoffBase = duration(
    options.backoff?.base ?? '1s',
    id,
    'backoff.base',
  );
  const backoffMax = duration(options.backoff?.max ?? '30s', id, 'backoff.max');
  if (backoffBase > backoffMax)
    invalid(
      id,
      'backoff.base must not exceed backoff.max',
      backoffBase,
      'Reduce base or increase max',
    );
  const policy = options.onStoreError ?? 'wait';
  if (!['wait', 'open', 'throw'].includes(policy))
    invalid(id, 'onStoreError is unknown', policy, 'Use wait, open, or throw');
  if (
    options.feedback !== undefined &&
    options.feedback !== false &&
    typeof options.feedback !== 'function'
  )
    invalid(
      id,
      'feedback must be a function or false',
      options.feedback,
      'Pass a feedback reader or false',
    );
  if (
    options.store &&
    (!options.store.kind ||
      ['acquire', 'pause', 'resume', 'close'].some(
        (key) =>
          typeof (options.store as unknown as Record<string, unknown>)[key] !==
          'function',
      ))
  )
    invalid(
      id,
      'store does not implement the store contract',
      options.store,
      'Provide acquire, pause, resume, close, and kind',
    );
  return {
    id,
    rules,
    concurrency,
    maxWait,
    maxPause,
    backoffBase,
    backoffMax,
    policy,
    maxQueue: integer(options.maxQueue ?? Infinity, id, 'maxQueue', true),
    batch: integer(options.batch ?? 32, id, 'batch'),
  };
}
