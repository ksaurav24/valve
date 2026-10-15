// Bounded store requests and collision-free identities shared by both backends.
import { failure } from './errors.js';
import type { NormalizedRule, ScopedAcquireRequest } from './store.js';

export function scopeSnapshot(
  id: string,
  dimensions: readonly string[],
  input: unknown,
): Readonly<Record<string, string>> {
  const bad = () =>
    failure(
      id,
      'INVALID_OPTIONS',
      'scopes must contain exactly the configured dimensions with opaque nonempty string values of at most 256 characters.',
    );
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad();
  const values = input as Record<string, unknown>;
  if (Object.keys(values).length !== dimensions.length) throw bad();
  const copy: Record<string, string> = Object.create(null);
  for (const dimension of dimensions) {
    if (!Object.hasOwn(values, dimension)) throw bad();
    const value = values[dimension];
    if (typeof value !== 'string' || !value.length || value.length > 256)
      throw bad();
    try {
      encodeURIComponent(value);
    } catch {
      throw bad();
    }
    copy[dimension] = value;
  }
  return Object.freeze(copy);
}

const compiled = new WeakMap<
  readonly NormalizedRule[],
  {
    dimensions: string[];
    fingerprint: string;
  }
>();

export function prepareScoped(request: ScopedAcquireRequest) {
  const bad = (message: string): never => {
    throw failure(request?.id, 'INVALID_OPTIONS', message);
  };
  if (
    !request ||
    typeof request.id !== 'string' ||
    !request.id.length ||
    request.id.length > 200 ||
    /[{}]/.test(request.id)
  )
    bad('Invalid scoped Valve id.');
  if (
    !Array.isArray(request.rules) ||
    !request.rules.length ||
    request.rules.length > 16 ||
    !Array.isArray(request.jobs) ||
    !request.jobs.length ||
    request.jobs.length > 128
  )
    bad('Scoped requests require 1-16 rules and 1-128 jobs.');
  let policy = compiled.get(request.rules);
  if (!policy) {
    const names = new Set<string>();
    const keys = new Set<string>();
    const dimensions = new Set<string>();
    for (const r of request.rules) {
      if (
        !r ||
        !['gcra', 'fixed-window'].includes(r.algorithm) ||
        !Number.isFinite(r.intervalMs) ||
        r.intervalMs < 1 ||
        r.intervalMs > Number.MAX_SAFE_INTEGER / 4 ||
        !Number.isSafeInteger(r.limit) ||
        r.limit < 1 ||
        !Number.isSafeInteger(r.burst) ||
        r.burst < 1 ||
        (r.intervalMs / r.limit) * r.burst > Number.MAX_SAFE_INTEGER / 4
      )
        bad('Invalid normalized scoped rule or numeric range.');
      for (const value of [r.name, r.scope])
        if (
          value !== undefined &&
          (typeof value !== 'string' ||
            !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value))
        )
          bad('Invalid scoped rule identifier.');
      if (r.scope !== undefined && r.name === undefined)
        bad('Scoped rules require names.');
      if (r.name !== undefined && names.has(r.name))
        bad('Duplicate scoped rule name.');
      if (r.name !== undefined) names.add(r.name);
      if (r.scope !== undefined) dimensions.add(r.scope);
      if (
        r.key !==
          (r.name === undefined
            ? `${r.algorithm}:${r.intervalMs}`
            : `named:${r.name}`) ||
        keys.has(r.key) ||
        (r.algorithm === 'fixed-window' && r.burst !== 1)
      )
        bad('Invalid normalized scoped key or burst.');
      keys.add(r.key);
    }
    if (!dimensions.size) bad('Scoped requests require scoped rules.');
    policy = {
      dimensions: [...dimensions],
      fingerprint: `scoped-v1:${JSON.stringify(request.rules.map((r) => [r.key, r.scope ?? null, r.algorithm, r.intervalMs, r.limit, r.burst]).sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)))}`,
    };
    // Only immutable policies can safely reuse validation and their fingerprint.
    if (Object.isFrozen(request.rules) && request.rules.every(Object.isFrozen))
      compiled.set(request.rules, policy);
  }
  const lease = request.lease;
  if (
    lease &&
    (!Number.isSafeInteger(lease.limit) ||
      lease.limit < 1 ||
      !Number.isFinite(lease.ttlMs) ||
      lease.ttlMs < 30 ||
      lease.ttlMs > Number.MAX_SAFE_INTEGER / 4 ||
      typeof lease.owner !== 'string' ||
      !lease.owner.length ||
      lease.owner.length > 256)
  )
    bad('Invalid scoped lease settings.');
  const rules: NormalizedRule[] = [];
  const keys: string[] = [];
  const indices = new Map<string, number>();
  const jobs = request.jobs.map((job) => {
    if (!job || !Number.isSafeInteger(job.cost) || job.cost < 1)
      bad('Scoped job cost must be a positive safe integer.');
    const scopes = scopeSnapshot(request.id, policy!.dimensions, job.scopes);
    const refs = request.rules.map((rule) => {
      if (job.cost > (rule.algorithm === 'gcra' ? rule.burst : rule.limit))
        bad('Scoped job cost exceeds rule capacity.');
      const key =
        rule.scope === undefined
          ? `r:${rule.key}`
          : `s:${rule.key}:${encodeURIComponent(scopes[rule.scope]!)}`;
      let index = indices.get(key);
      if (index === undefined) {
        index = keys.length;
        indices.set(key, index);
        keys.push(key);
        rules.push(rule);
      }
      return index;
    });
    return { cost: job.cost, refs };
  });
  return {
    rules,
    keys,
    jobs,
    fingerprint: `${policy.fingerprint}:${lease ? `${lease.limit}:${lease.ttlMs}` : 'local'}`,
  };
}
