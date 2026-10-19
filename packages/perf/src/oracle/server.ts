// Server-side oracles over instrumented admission logs (Redis TIME, execution order).
// GCRA is replayed exactly (Lua is deterministic, so any disagreement is a violation) and also
// checked against the documented window guarantee; fixed windows per aligned window; scoped
// rules per identity key; leases by an occupancy timeline over grants, renewals, releases, expiry.
import type { ServerEvent, Violation } from '../core/types.ts';

export interface Grant {
  t: number;
  cost: number;
}
export interface RuleGrants {
  key: string;
  rule: {
    algorithm: 'gcra' | 'fixed-window';
    intervalMs: number;
    limit: number;
    burst: number;
  };
  grants: Grant[];
}

/** Group granted cost by full rule key (scoped keys include the identity). */
export function grantsByRule(
  events: readonly ServerEvent[],
): Map<string, RuleGrants> {
  const out = new Map<string, RuleGrants>();
  const add = (
    key: string,
    rule: RuleGrants['rule'],
    t: number,
    cost: number,
  ) => {
    let g = out.get(key);
    if (!g) out.set(key, (g = { key, rule, grants: [] }));
    g.grants.push({ t, cost });
  };
  for (const e of events) {
    if (e.op === 'acquire' && e.granted > 0)
      for (let j = 0; j < e.granted; j++)
        e.rules.forEach((rule, i) =>
          add(e.ruleKeys[i]!, rule, e.t, e.costs[j]!),
        );
    if (e.op === 'scoped')
      for (const index of e.grantedIndexes) {
        const job = e.jobs[index]!;
        for (const ref of job.refs)
          add(e.ruleKeys[ref]!, e.rules[ref]!, e.t, job.cost);
      }
  }
  return out;
}

const TOLERANCE_MS = 1e-6;

/**
 * Check every rule key. `resets` are server times at which store state was lost (restart),
 * after which a fresh budget is the documented behavior.
 */
export function checkRates(
  events: readonly ServerEvent[],
  resets: readonly number[] = [],
): {
  violations: Violation[];
  keys: number;
  grants: number;
} {
  const violations: Violation[] = [];
  let grants = 0;
  const groups = grantsByRule(events);
  for (const { key, rule, grants: list } of groups.values()) {
    grants += list.length;
    const segments = splitAt(list, resets);
    for (const seg of segments) {
      if (rule.algorithm === 'gcra') {
        const step = rule.intervalMs / rule.limit;
        let tat = 0;
        for (const g of seg) {
          const allowAt =
            Math.max(tat, g.t) + step * g.cost - step * rule.burst;
          if (g.t + TOLERANCE_MS < allowAt)
            violations.push({
              class: 'rate-bound',
              detail: `${key}: GCRA grant ${(allowAt - g.t).toFixed(4)}ms early (cost ${g.cost})`,
              magnitude: allowAt - g.t,
              at: g.t,
            });
          tat = Math.max(tat, g.t) + step * g.cost;
        }
        // Documented guarantee: total cost in any half-open window of length `interval` ≤ limit + burst - 1.
        const cap = rule.limit + rule.burst - 1;
        let lo = 0;
        let sum = 0;
        for (let hi = 0; hi < seg.length; hi++) {
          sum += seg[hi]!.cost;
          while (seg[hi]!.t - seg[lo]!.t >= rule.intervalMs)
            sum -= seg[lo++]!.cost;
          if (sum > cap) {
            violations.push({
              class: 'rate-bound',
              detail: `${key}: ${sum} cost in < ${rule.intervalMs}ms window (cap ${cap})`,
              magnitude: sum - cap,
              at: seg[hi]!.t,
            });
            break;
          }
        }
      } else {
        const counts = new Map<number, number>();
        for (const g of seg) {
          const w = Math.floor(g.t / rule.intervalMs);
          counts.set(w, (counts.get(w) ?? 0) + g.cost);
        }
        for (const [w, n] of counts)
          if (n > rule.limit)
            violations.push({
              class: key.includes(':s:') ? 'scoped-bound' : 'window-bound',
              detail: `${key}: window ${w} admitted ${n} > ${rule.limit}`,
              magnitude: n - rule.limit,
              at: w * rule.intervalMs,
            });
      }
    }
  }
  return { violations, keys: groups.size, grants };
}

function splitAt(list: readonly Grant[], resets: readonly number[]): Grant[][] {
  if (!resets.length) return [list as Grant[]];
  const sorted = [...resets].sort((a, b) => a - b);
  const out: Grant[][] = [[]];
  let r = 0;
  for (const g of list) {
    while (r < sorted.length && g.t >= sorted[r]!) {
      out.push([]);
      r++;
    }
    out.at(-1)!.push(g);
  }
  return out;
}

/** Replay lease grants/renewals/releases and verify occupancy never exceeds the limit. */
export function checkLeases(
  events: readonly ServerEvent[],
  resets: readonly number[] = [],
): {
  violations: Violation[];
  maxOccupancy: number;
  limit: number | null;
} {
  const violations: Violation[] = [];
  const slots = new Map<string, Map<string, number>>();
  const leaseKeyOf = (e: ServerEvent) =>
    e.op === 'release' || e.op === 'renew' ? e.leaseKey : `${e.id}`;
  let maxOccupancy = 0;
  let limit: number | null = null;
  const sortedResets = [...resets].sort((a, b) => a - b);
  let r = 0;
  for (const e of events) {
    while (r < sortedResets.length && e.t >= sortedResets[r]!) {
      slots.clear();
      r++;
    }
    const key = leaseKeyOf(e)
      .replace(/:leases$/, '')
      .replace(/^.*\{([^}]*)\}.*$/, '$1');
    let set = slots.get(key);
    if (!set) slots.set(key, (set = new Map()));
    // ZREMRANGEBYSCORE -inf now: slots expiring at or before now are gone.
    for (const [token, exp] of set) if (exp <= e.t) set.delete(token);
    if (e.op === 'acquire' && e.lease) {
      limit = e.lease.limit;
      for (const token of e.lease.tokens) set.set(token, e.t + e.lease.ttlMs);
      if (set.size > e.lease.limit)
        violations.push({
          class: 'lease-oversubscription',
          detail: `${key}: ${set.size} slots held > limit ${e.lease.limit}`,
          magnitude: set.size - e.lease.limit,
          at: e.t,
        });
    } else if (e.op === 'scoped' && e.lease) {
      limit = e.lease.limit;
      for (const { token } of e.lease.tokens)
        set.set(token, e.t + e.lease.ttlMs);
      if (set.size > e.lease.limit)
        violations.push({
          class: 'lease-oversubscription',
          detail: `${key}: ${set.size} slots held > limit ${e.lease.limit}`,
          magnitude: set.size - e.lease.limit,
          at: e.t,
        });
    } else if (e.op === 'renew') {
      for (const token of e.tokens)
        if (set.has(token)) set.set(token, e.t + e.ttlMs);
    } else if (e.op === 'release') {
      for (const token of e.tokens) set.delete(token);
    }
    maxOccupancy = Math.max(maxOccupancy, set.size);
  }
  return { violations, maxOccupancy, limit };
}

/**
 * Split zero-grant acquire calls into `early` (sent before the eligibility implied by the last
 * granted state of the binding single GCRA rule) and `lostRace` (eligible, but another caller
 * won). Only defined for single-rule GCRA static cells; returns null otherwise.
 */
export function classifyZeroGrants(
  events: readonly ServerEvent[],
): { early: number; lostRace: number; zero: number } | null {
  const acquires = events.filter(
    (e): e is Extract<ServerEvent, { op: 'acquire' }> => e.op === 'acquire',
  );
  if (
    !acquires.length ||
    acquires.some(
      (e) =>
        e.rules.length !== 1 || e.rules[0]!.algorithm !== 'gcra' || e.lease,
    )
  )
    return null;
  let tat = 0;
  let early = 0;
  let lostRace = 0;
  let zero = 0;
  for (const e of acquires) {
    const rule = e.rules[0]!;
    const step = rule.intervalMs / rule.limit;
    const head = e.costs[0] ?? 1;
    if (e.granted === 0 && e.pausedMs === 0) {
      zero++;
      // Earliest time the head could have been granted given the state after the previous grant.
      const eligibleAt = tat + step * head - step * rule.burst;
      if (e.t < eligibleAt) early++;
      else lostRace++;
    }
    for (let j = 0; j < e.granted; j++)
      tat = Math.max(tat, e.t) + step * e.costs[j]!;
  }
  return { early, lostRace, zero };
}
