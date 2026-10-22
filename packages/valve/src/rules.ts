// Synchronous validation of valve options and stable rule normalization.
import { duration, integer } from './duration.js';
import { failure, invalid } from './errors.js';
import type { NormalizedRule } from './store.js';
import type { ValveOptions } from './types.js';
/**
 * Validate options before creating a queue and resolve defaults, durations and rule keys.
 * Scoped policies also require bounded batches and a store with scoped admission support.
 * @throws {ValveError} INVALID_OPTIONS when the policy cannot be enforced as configured.
 */
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
  const concurrencyOptions =
    typeof options.concurrency === 'object' ? options.concurrency : undefined;
  if (options.concurrency === null)
    invalid(
      id,
      'concurrency must not be null',
      null,
      'Use a number or concurrency options',
    );
  const concurrency = integer(
    concurrencyOptions
      ? concurrencyOptions.limit
      : ((options.concurrency ?? Infinity) as number),
    id,
    'concurrency',
    !concurrencyOptions,
  );
  const scope = concurrencyOptions?.scope ?? 'local';
  if (scope !== 'local' && scope !== 'global')
    invalid(id, 'concurrency.scope is unknown', scope, 'Use local or global');
  const leaseTtl = duration(
    concurrencyOptions?.leaseTtl ?? '30s',
    id,
    'concurrency.leaseTtl',
  );
  if (leaseTtl < 30)
    invalid(
      id,
      'concurrency.leaseTtl must be at least 30ms',
      leaseTtl,
      'Use enough time to renew the lease',
    );
  if (scope === 'local' && concurrencyOptions?.leaseTtl !== undefined)
    invalid(
      id,
      'leaseTtl requires global concurrency',
      leaseTtl,
      'Use scope global',
    );
  if (
    scope === 'global' &&
    options.store &&
    (typeof options.store.release !== 'function' ||
      typeof options.store.renew !== 'function')
  )
    invalid(
      id,
      'global concurrency requires release and renew',
      options.store.kind,
      'Use a lease-capable store',
    );
  if (scope === 'global' && options.onStoreError === 'open')
    invalid(
      id,
      'global concurrency cannot fail open',
      'open',
      'Use wait or throw to preserve the shared limit',
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
  const names = new Set<string>();
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
    for (const field of ['name', 'scope'] as const) {
      if (
        rule[field] !== undefined &&
        (typeof rule[field] !== 'string' ||
          !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(rule[field]))
      )
        throw failure(
          id,
          'INVALID_OPTIONS',
          `rate[${i}].${field} must be a 1-64 character identifier beginning with a letter.`,
        );
    }
    if (rule.scope !== undefined && rule.name === undefined)
      throw failure(
        id,
        'INVALID_OPTIONS',
        'Scoped rules require a unique name.',
      );
    if (rule.name !== undefined && names.has(rule.name))
      throw failure(id, 'INVALID_OPTIONS', `Duplicate rule name ${rule.name}.`);
    if (rule.name !== undefined) names.add(rule.name);
    const key =
      rule.name === undefined
        ? `${algorithm}:${intervalMs}`
        : `named:${rule.name}`;
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
      ...(rule.name === undefined ? {} : { name: rule.name }),
      ...(rule.scope === undefined ? {} : { scope: rule.scope }),
    };
  });
  const limits = options.limits ?? 'immutable';
  if (limits !== 'immutable' && limits !== 'managed')
    invalid(id, 'limits is unknown', limits, 'Use immutable or managed');
  const managed = limits === 'managed';
  if (managed && (!rules.length || rules.some((rule) => !rule.name)))
    throw failure(
      id,
      'INVALID_OPTIONS',
      'Managed limits require at least one rate rule, and every rule needs a name.',
    );
  const capability = options.store?.managed;
  if (
    managed &&
    options.store &&
    (!capability ||
      capability.version !== 1 ||
      typeof capability.acquire !== 'function' ||
      typeof capability.getLimits !== 'function' ||
      typeof capability.updateLimits !== 'function' ||
      (rules.some((rule) => rule.scope !== undefined) &&
        typeof capability.acquireScoped !== 'function'))
  )
    throw failure(
      id,
      'INVALID_OPTIONS',
      'Managed limits require a store with managed support (store.managed version 1).',
    );
  const scopes = [
    ...new Set(
      rules.flatMap((rule) => (rule.scope === undefined ? [] : [rule.scope])),
    ),
  ];
  const scoped = scopes.length > 0;
  if (scoped && (rules.length > 16 || (options.batch ?? 32) > 128))
    throw failure(
      id,
      'INVALID_OPTIONS',
      'Scoped admission supports at most 16 rules and batch 128.',
    );
  if (
    (scoped || managed) &&
    rules.some(
      (rule) =>
        rule.intervalMs > Number.MAX_SAFE_INTEGER / 4 ||
        (rule.intervalMs / rule.limit) * rule.burst >
          Number.MAX_SAFE_INTEGER / 4,
    )
  )
    throw failure(
      id,
      'INVALID_OPTIONS',
      'Scoped or managed rate durations exceed the safe numeric range.',
    );
  if (
    scoped &&
    !managed &&
    options.store &&
    typeof options.store.acquireScoped !== 'function'
  )
    throw failure(
      id,
      'INVALID_OPTIONS',
      'Scoped rules require a store with acquireScoped.',
    );
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
    rules:
      scoped || managed
        ? Object.freeze(rules.map((rule) => Object.freeze(rule)))
        : rules,
    managed,
    scopes,
    scoped,
    concurrency,
    global: scope === 'global',
    leaseTtl,
    maxWait,
    maxPause,
    backoffBase,
    backoffMax,
    policy,
    maxQueue: integer(options.maxQueue ?? Infinity, id, 'maxQueue', true),
    batch: integer(options.batch ?? 32, id, 'batch'),
  };
}
/** Canonical versioned fingerprint of static rules that ignores rule order.
 * @param rules Normalized rules from one static policy.
 * @returns The fingerprint shared stores compare across workers.
 */
export function ruleFingerprint(rules: readonly NormalizedRule[]) {
  return `${rules.some((rule) => rule.name) ? 'named-v1' : 'v1'}:[${rules
    .map((rule) =>
      JSON.stringify([
        rule.algorithm,
        rule.intervalMs,
        rule.limit,
        rule.burst,
        ...(rule.name ? [rule.name] : []),
      ]),
    )
    .sort()
    .join(',')}]`;
}
