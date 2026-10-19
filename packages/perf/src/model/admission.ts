// Direct admission math from acquire.lua and scoped.lua, using fractional milliseconds.
import { expire, ruleKey } from './state.ts';
import type { AdmissionState, Rule } from './state.ts';
/** Lease policy; owners must be unique per call, as in Valve. */
export interface Lease {
  limit: number;
  ttlMs: number;
  owner: string;
}
/** A static prefix admission request. */
export interface Request {
  rules: readonly Rule[];
  costs: readonly number[];
  lease?: Lease;
}
/** Static reply; tokens use the original zero-based job index. */
export interface Result {
  granted: number;
  retryAfterMs: number;
  pausedMs: number;
  tokens?: string[];
  leaseBlocked?: boolean;
}
/** Prepared sparse request: refs are zero-based rule indexes. */
export interface ScopedRequest {
  rules: readonly Rule[];
  jobs: readonly { cost: number; refs: readonly number[] }[];
  lease?: Lease;
}
/** Sparse reply in the same shape as the public Store API (tokens named explicitly). */
export interface ScopedResult {
  grantedIndexes: number[];
  blocked: { index: number; retryAfterMs: number; leaseBlocked?: boolean }[];
  tokens?: { index: number; token: string }[];
  pausedMs: number;
}
/** Exact rule eligibility delay, without rounding the retry hint. */
export function ruleDelay(
  state: AdmissionState,
  rule: Rule,
  index: number,
  cost: number,
  now: number,
): number {
  const value = state.rules.get(ruleKey(rule, index));
  const current = value && value.expiresAt > now ? value : undefined;
  if (rule.algorithm === 'gcra') {
    const tat = current?.kind === 'gcra' ? current.tat : 0;
    const step = rule.intervalMs / rule.limit;
    return Math.max(
      0,
      Math.max(tat, now) + step * cost - step * rule.burst - now,
    );
  }
  const w = Math.floor(now / rule.intervalMs);
  const n = current?.kind === 'fixed-window' && current.w === w ? current.n : 0;
  return n + cost > rule.limit ? (w + 1) * rule.intervalMs - now : 0;
}
function spend(
  state: AdmissionState,
  rule: Rule,
  index: number,
  cost: number,
  now: number,
  scoped: boolean,
): void {
  const key = ruleKey(rule, index);
  const value = state.rules.get(key);
  if (rule.algorithm === 'gcra') {
    const tat =
      Math.max(value?.kind === 'gcra' ? value.tat : 0, now) +
      (rule.intervalMs / rule.limit) * cost;
    state.rules.set(key, { kind: 'gcra', tat, expiresAt: Math.ceil(tat) });
  } else {
    const w = Math.floor(now / rule.intervalMs);
    const n =
      (value?.kind === 'fixed-window' && value.w === w ? value.n : 0) + cost;
    state.rules.set(key, {
      kind: 'fixed-window',
      w,
      n,
      expiresAt: scoped
        ? Math.ceil((w + 1) * rule.intervalMs)
        : Math.floor(now) + Math.ceil(2 * rule.intervalMs),
    });
  }
}
function pauseLeft(state: AdmissionState, now: number): number {
  return Math.max(0, state.untilMs - Math.floor(now));
}
/** Grant a prefix, checking leases before rules for each job, exactly as acquire.lua. */
export function acquire(
  state: AdmissionState,
  request: Request,
  now: number,
): Result {
  const pausedMs = pauseLeft(state, now);
  if (pausedMs > 0) return { granted: 0, retryAfterMs: pausedMs, pausedMs };
  expire(state, now);
  const slots = state.leases.size;
  const earliest = slots
    ? Math.min(...state.leases.values())
    : now + (request.lease?.ttlMs ?? 0);
  let granted = 0,
    retryAfterMs = 0,
    leaseBlocked = false;
  for (const cost of request.costs) {
    retryAfterMs = 0;
    if (request.lease && slots + granted >= request.lease.limit) {
      retryAfterMs = Math.max(1, Math.ceil(earliest - now));
      leaseBlocked = true;
      break;
    }
    request.rules.forEach((r, i) => {
      retryAfterMs = Math.max(
        retryAfterMs,
        Math.ceil(ruleDelay(state, r, i, cost, now)),
      );
    });
    if (retryAfterMs > 0) break;
    request.rules.forEach((r, i) => spend(state, r, i, cost, now, false));
    granted++;
  }
  const result: Result = { granted, retryAfterMs, pausedMs: 0 };
  if (request.lease) {
    result.tokens = Array.from(
      { length: granted },
      (_, i) => `${request.lease!.owner}:${i}`,
    );
    for (const token of result.tokens)
      state.leases.set(token, now + request.lease.ttlMs);
    result.leaseBlocked = leaseBlocked;
  }
  return result;
}
/** Admit sparse jobs atomically, continuing after each denial. Input is already validated. */
export function acquireScoped(
  state: AdmissionState,
  request: ScopedRequest,
  now: number,
): ScopedResult {
  // scoped.lua reads before sweeping. Lua 5.1 concatenation uses %.14g for
  // '(' .. now, whereas numeric redis.call arguments retain double precision.
  // At epoch-scale fractional times these are observably different thresholds.
  for (const [key, value] of state.rules)
    if (value.expiresAt <= now) state.rules.delete(key);
  if (state.leases.size && Math.ceil(Math.max(...state.leases.values())) <= now)
    state.leases.clear();
  const live = [...state.leases.values()].filter(
    (end) => end > Number(now.toPrecision(14)),
  );
  const pausedMs = pauseLeft(state, now);
  const slots = live.length;
  const earliest = slots
    ? Math.min(...live)
    : now + (request.lease?.ttlMs ?? 0);
  const result: ScopedResult = {
    grantedIndexes: [],
    blocked: [],
    pausedMs,
    ...(request.lease ? { tokens: [] } : {}),
  };
  request.jobs.forEach((job, index) => {
    const leaseRetry =
      request.lease &&
      slots + result.grantedIndexes.length >= request.lease.limit
        ? Math.max(1, Math.ceil(earliest - now))
        : 0;
    let retry = Math.max(pausedMs, leaseRetry);
    for (const ref of job.refs)
      retry = Math.max(
        retry,
        Math.ceil(ruleDelay(state, request.rules[ref]!, ref, job.cost, now)),
      );
    if (retry > 0)
      result.blocked.push({
        index,
        retryAfterMs: retry,
        ...(request.lease ? { leaseBlocked: retry === leaseRetry } : {}),
      });
    else {
      result.grantedIndexes.push(index);
      for (const ref of job.refs)
        spend(state, request.rules[ref]!, ref, job.cost, now, true);
      if (request.lease)
        result.tokens!.push({
          index,
          token: `${request.lease.owner}:${index}`,
        });
    }
  });
  if (request.lease) {
    for (const [token, end] of state.leases)
      if (end <= now) state.leases.delete(token);
    for (const { token } of result.tokens!)
      state.leases.set(token, now + request.lease.ttlMs);
  }
  return result;
}
/** Release named ownership (including expired members); now is explicit for trace symmetry. */
export function release(
  state: AdmissionState,
  tokens: readonly string[],
  _now: number,
): void {
  void _now;
  for (const token of tokens) state.leases.delete(token);
}
/** Renew existing unexpired members only; valid is false if any token was lost. */
export function renew(
  state: AdmissionState,
  tokens: readonly string[],
  ttlMs: number,
  now: number,
): boolean {
  expire(state, now);
  let valid = true;
  for (const token of tokens) {
    if (state.leases.has(token)) state.leases.set(token, now + ttlMs);
    else valid = false;
  }
  return valid;
}
/** Extend the millisecond Redis pause TTL; shorter pauses cannot shorten it. */
export function pause(state: AdmissionState, ms: number, now: number): void {
  state.untilMs = Math.max(state.untilMs, Math.floor(now) + Math.ceil(ms));
}
