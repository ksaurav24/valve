// Closed-form rates and event-driven, zero-latency admission bounds over offered demand.
import { acquire, acquireScoped, release, ruleDelay } from './admission.ts';
import type { Lease } from './admission.ts';
import { cloneState, createState } from './state.ts';
import type { AdmissionState, Rule } from './state.ts';
/** Inputs for the descriptive long-run denominator (burst bank is excluded). */
export interface CapacityOptions {
  activeIdentities?: number;
  lease?: { limit: number; meanDurationMs: number };
  cost?: number;
}
/** Long-run cost capacity: min rate*T; fixed windows contribute limit per aligned interval.
 * This is a rate denominator, not an attainable finite-window bound. GCRA's initial
 * burst bank can add burst-1 unit jobs; fixed windows may straddle a 2*limit boundary.
 * activeIdentities applies only to independent copies of the entire rule set.
 */
export function ruleCapacity(
  rules: readonly Rule[],
  windowMs: number,
  opts: CapacityOptions = {},
): number {
  if (windowMs === 0) return 0;
  const rate =
    Math.min(...rules.map((r) => r.limit / r.intervalMs)) *
    (opts.activeIdentities ?? 1);
  const leaseRate = opts.lease
    ? (opts.lease.limit / opts.lease.meanDurationMs) * (opts.cost ?? 1)
    : Infinity;
  return Math.min(rate, leaseRate) * windowMs;
}
/** One exogenous arrival; scopeKeys selects the identity of each rule, including shared keys. */
export interface Arrival {
  at: number;
  cost: number;
  durationMs?: number;
  scopeKeys?: readonly string[];
}
/** Inputs to the ideal supply bound; the snapshot is never mutated. */
export interface BoundInput {
  rules: readonly Rule[];
  lease?: Omit<Lease, 'owner'>;
  initialState?: AdmissionState;
  t0: number;
  t1: number;
  demand:
    | { arrivals: readonly Arrival[] }
    | { saturated: { cost: number; durationMs?: number } };
  prefix: boolean;
}
/** Finite-window cost and job bound with its replayable admission schedule. */
export interface BoundResult {
  admittedCost: number;
  admittedJobs: number;
  grants: { at: number; cost: number }[];
  headOfLineLossCost?: number;
}
function nextNumber(x: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  view.setBigUint64(0, view.getBigUint64(0) + (x >= 0 ? 1n : -1n));
  return view.getFloat64(0);
}
/** Greedy earliest starts. For unit-cost FIFO jobs with identical resource needs and
 * fixed durations, exchanging a later start for an available earlier start cannot
 * delay any subsequent start: the rate budget refills earlier and leases end earlier.
 * This proves earliest-start optimality under those assumptions. Weighted prefix
 * is a bound for Valve's ordering semantics, not an optimum over reorderings.
 * Skipping is a declared greedy policy, not a global weighted/scoped optimum.
 */
export function idealBound(input: BoundInput): BoundResult {
  const state = cloneState(input.initialState ?? createState());
  const saturated =
    'saturated' in input.demand ? input.demand.saturated : undefined;
  const pending: Arrival[] =
    'arrivals' in input.demand
      ? [...input.demand.arrivals].sort((a, b) => a.at - b.at)
      : [];
  const releases: { at: number; token: string }[] = [];
  const grants: BoundResult['grants'] = [];
  let now = input.t0,
    serial = 0;
  if (
    saturated &&
    !input.rules.length &&
    (!input.lease || saturated.durationMs === 0)
  )
    throw new RangeError('Unbounded instantaneous saturated supply');
  while (now < input.t1 && (saturated || pending.length)) {
    for (let i = releases.length - 1; i >= 0; i--)
      if (releases[i]!.at <= now) {
        release(state, [releases[i]!.token], now);
        releases.splice(i, 1);
      }
    for (const [key, value] of state.rules)
      if (value.expiresAt <= now) state.rules.delete(key);
    if (
      state.leases.size &&
      Math.ceil(Math.max(...state.leases.values())) <= now
    )
      state.leases.clear();
    let next = input.t1,
      progressed = false;
    const candidates = saturated ? [{ ...saturated, at: input.t0 }] : pending;
    for (let i = 0; i < candidates.length; i++) {
      const job = candidates[i]!;
      if (job.at > now) {
        next = Math.min(next, job.at);
        break;
      }
      const rules = input.rules.map((r, index) => ({
        ...r,
        key: job.scopeKeys?.[index] ?? r.key ?? String(index),
      }));
      const scoped = job.scopeKeys !== undefined;
      const lease = input.lease
        ? { ...input.lease, owner: `ideal-${serial++}` }
        : undefined;
      const result = scoped
        ? acquireScoped(
            state,
            {
              rules,
              jobs: [{ cost: job.cost, refs: rules.map((_, j) => j) }],
              ...(lease ? { lease } : {}),
            },
            now,
          )
        : acquire(
            state,
            { rules, costs: [job.cost], ...(lease ? { lease } : {}) },
            now,
          );
      const granted =
        'granted' in result
          ? result.granted > 0
          : result.grantedIndexes.length > 0;
      if (!granted) {
        let delay = Math.max(0, state.untilMs - now);
        rules.forEach((r, index) => {
          delay = Math.max(
            delay,
            job.cost > (r.algorithm === 'gcra' ? r.burst : r.limit)
              ? Infinity
              : ruleDelay(state, r, index, job.cost, now),
          );
        });
        const liveLeases = [...state.leases.values()].filter(
          (end) => end > (scoped ? Number(now.toPrecision(14)) : now),
        );
        if (input.lease && liveLeases.length >= input.lease.limit) {
          const earliest = Math.min(...liveLeases);
          let eligible = earliest;
          if (scoped) {
            // First representable instant whose Lua string score reaches expiry.
            const unit =
              10 **
              (Math.floor(Math.log10(Math.max(1, Math.abs(earliest)))) - 13);
            eligible = Math.ceil(earliest / unit) * unit - unit / 2;
            while (Number(eligible.toPrecision(14)) < earliest)
              eligible = nextNumber(eligible);
            eligible = Math.min(eligible, earliest);
          }
          delay = Math.max(delay, eligible - now);
        }
        // A denied sparse call may sweep an equal-expiry lease after counting
        // it with a rounded score. A zero-latency reattempt is a state transition,
        // not a timer poll. All other denials advance to exact eligibility.
        if (delay === 0) {
          progressed = true;
          break;
        }
        next = Math.min(
          next,
          now + delay > now ? now + delay : nextNumber(now),
        );
        if (input.prefix) break;
        continue;
      }
      grants.push({ at: now, cost: job.cost });
      const token = result.tokens?.[0];
      if (token !== undefined && job.durationMs !== undefined)
        releases.push({
          at: now + job.durationMs,
          token: typeof token === 'string' ? token : token.token,
        });
      if (!saturated) pending.splice(i, 1);
      progressed = true;
      break;
    }
    if (!progressed) {
      for (const event of releases)
        if (event.at > now) next = Math.min(next, event.at);
      now = next;
    }
  }
  const admittedCost = grants.reduce((sum, g) => sum + g.cost, 0);
  return {
    admittedCost,
    admittedJobs: grants.length,
    grants,
    ...(input.prefix
      ? {
          headOfLineLossCost:
            idealBound({ ...input, prefix: false }).admittedCost - admittedCost,
        }
      : {}),
  };
}
