// Managed limits: fingerprints, patch validation, and virtual-time GCRA math mirrored by managed.lua.
import { failure } from './errors.js';
import type { RuleState } from './algorithms.js';
import { ruleFingerprint } from './rules.js';
import { scopedFingerprint } from './scoped.js';
import type {
  LimitsPatch,
  LimitsSnapshot,
  ManagedContext,
  NormalizedRule,
} from './store.js';

const MAX = Number.MAX_SAFE_INTEGER / 4;

/**
 * Authoritative values of one managed rule plus its virtual-time frame.
 *
 * GCRA state is a virtual arrival time X on the axis
 * `theta(now) = th + (now - c) * sr / step`, where `step = intervalMs / limit`.
 * Debt `(X - theta) / sr` is measured in cost units and drains at the current
 * rate, so a rate change only rebases the frame and every key keeps its units,
 * however many revisions it skipped. Before the first rate change the frame is
 * the identity (`c = th = 0`, `step = sr`) and the math equals immutable mode.
 */
export interface FrameRule {
  readonly algorithm: 'gcra' | 'fixed-window';
  readonly intervalMs: number;
  limit: number;
  burst: number;
  /** Real time and theta at the last rate change. */
  c: number;
  th: number;
  /** Low-order remainder retained when rebasing a large virtual coordinate. */
  tr: number;
  /** Step at registration. Fixed for the life of the frame. */
  readonly sr: number;
  /** End of the window in which scoped keys may expire too early after a decrease. */
  sw: number;
  /** Largest burst ever configured, which bounds any key's debt. */
  ub: number;
}

/** The current virtual time of a GCRA rule. */
export function theta(rule: FrameRule, now: number): number {
  return (
    rule.th +
    (rule.tr + (now - rule.c) * (rule.sr / (rule.intervalMs / rule.limit)))
  );
}

/** Compensated addition prevents repeated small rebases from forgiving debt. */
function rebase(rule: FrameRule, now: number) {
  const delta = (now - rule.c) * (rule.sr / (rule.intervalMs / rule.limit));
  const sum = rule.th + delta;
  const part = sum - rule.th;
  const remainder = rule.th - (sum - part) + (delta - part) + rule.tr;
  const next = sum + remainder;
  rule.tr = remainder - (next - sum);
  rule.th = next;
  rule.c = now;
}

/** Keep virtual coordinates precise enough to record individual cost units. */
export function precise(
  rule: FrameRule,
  now: number,
  limit = rule.limit,
  burst = rule.burst,
) {
  if (rule.algorithm !== 'gcra') return true;
  const t = theta(rule, now);
  const extent = Math.abs(t) + rule.sr * Math.max(rule.ub, burst, limit);
  return Number.isFinite(extent) && extent * Number.EPSILON <= rule.sr / 1024;
}

/** Converts virtual milliseconds to real milliseconds at the current rate. */
export function ratio(rule: FrameRule): number {
  return rule.intervalMs / rule.limit / rule.sr;
}

/** Whether no rate change has rebased the frame, so real and virtual time coincide. */
export function identity(rule: FrameRule): boolean {
  return (
    rule.c === 0 &&
    rule.th === 0 &&
    rule.tr === 0 &&
    rule.intervalMs / rule.limit === rule.sr
  );
}

/** A rule's capacity for one job: burst for GCRA, limit for fixed windows. */
export function capacity(rule: {
  algorithm: string;
  limit: number;
  burst: number;
}) {
  return rule.algorithm === 'gcra' ? rule.burst : rule.limit;
}

/** Frame for newly registered or adopted values. */
export function register(rule: NormalizedRule): FrameRule {
  return {
    algorithm: rule.algorithm,
    intervalMs: rule.intervalMs,
    limit: rule.limit,
    burst: rule.burst,
    c: 0,
    th: 0,
    tr: 0,
    sr: rule.intervalMs / rule.limit,
    sw: 0,
    ub: rule.burst,
  };
}

/** Structural marker shared by every managed worker of one id. Limits and bursts are excluded. */
export function marker(context: ManagedContext): string {
  const scoped = context.rules.some((rule) => rule.scope !== undefined);
  return `managed-v1:${scoped ? 'scoped' : 'static'}:${JSON.stringify(
    context.rules
      .map((rule) => [
        rule.name,
        rule.scope ?? null,
        rule.algorithm,
        rule.intervalMs,
      ])
      .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
  )}:${lease(context)}`;
}

/** The immutable fingerprint the context's registration values would pin. */
export function pin(context: ManagedContext): string {
  const scoped = context.rules.some((rule) => rule.scope !== undefined);
  return `${scoped ? scopedFingerprint(context.rules) : ruleFingerprint(context.rules)}:${lease(context)}`;
}

/** Serialize the global lease settings included in shared quota fingerprints. */
function lease(context: ManagedContext) {
  return context.lease
    ? `${context.lease.limit}:${context.lease.ttlMs}`
    : 'local';
}

/** Validate a patch against the shared structure before any store write.
 * @returns Entries with every field present.
 * @throws {ValveError} INVALID_OPTIONS for unknown rules, fields, values, or fixed-window bursts.
 */
export function checkPatch(
  id: string,
  rules: readonly NormalizedRule[],
  patch: unknown,
  option = 'limits patch',
): [string, { limit?: number; burst?: number }][] {
  const bad = (message: string): never => {
    throw failure(id, 'INVALID_OPTIONS', `${option} ${message}`);
  };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    bad('must be an object keyed by rule name.');
  const entries: [string, { limit?: number; burst?: number }][] = [];
  for (const [name, value] of Object.entries(patch as LimitsPatch)) {
    const rule = rules.find((candidate) => candidate.name === name);
    if (!rule) bad(`names unknown rule ${JSON.stringify(name)}.`);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      bad(`for ${name} must be an object with limit or burst.`);
    const fields: { limit?: number; burst?: number } = {};
    for (const [field, number] of Object.entries(value)) {
      if (field !== 'limit' && field !== 'burst')
        bad(
          `for ${name} may change only limit and burst. Changing ${field} requires a coordinated migration.`,
        );
      if (field === 'burst' && rule!.algorithm !== 'gcra')
        bad(`for ${name} cannot set burst on a fixed-window rule.`);
      if (!Number.isSafeInteger(number) || (number as number) < 1)
        bad(`for ${name}.${field} must be a positive integer.`);
      fields[field as 'limit' | 'burst'] = number as number;
    }
    entries.push([name, fields]);
  }
  return entries;
}

/**
 * Apply a validated patch to authoritative rules at `now`, all or nothing.
 * @returns Whether anything changed and whether any limit or burst increased.
 * @throws {ValveError} INVALID_OPTIONS for an unsafe numeric range, or LIMITS_CONFLICT when `expect` fails.
 */
export function applyPatch(
  id: string,
  rules: Map<string, FrameRule>,
  patch: [string, { limit?: number; burst?: number }][],
  expect: [string, { limit?: number; burst?: number }][],
  now: number,
) {
  for (const [name, fields] of expect) {
    const rule = rules.get(name)!;
    const target = patch.find(([candidate]) => candidate === name)?.[1];
    for (const field of ['limit', 'burst'] as const) {
      const value = fields[field];
      if (
        value !== undefined &&
        rule[field] !== value &&
        target?.[field] !== rule[field]
      )
        throw failure(
          id,
          'LIMITS_CONFLICT',
          `limits changed concurrently: ${name}.${field} is ${rule[field]}, expected ${value}. Read the current limits and retry.`,
        );
    }
  }
  const next: [FrameRule, number, number][] = [];
  for (const [name, fields] of patch) {
    const rule = rules.get(name)!;
    const limit = fields.limit ?? rule.limit;
    const burst = fields.burst ?? rule.burst;
    const step = rule.intervalMs / limit;
    if (
      rule.algorithm === 'gcra' &&
      (rule.sr * burst > MAX ||
        step * Math.max(rule.ub, burst) > MAX ||
        !precise(rule, now, limit, burst))
    )
      throw failure(
        id,
        'INVALID_OPTIONS',
        `limits patch for ${name} exceeds the safe numeric range.`,
      );
    next.push([rule, limit, burst]);
  }
  let changed = false;
  let relaxed = false;
  for (const [rule, limit, burst] of next) {
    if (limit === rule.limit && burst === rule.burst) continue;
    changed = true;
    relaxed ||= limit > rule.limit || burst > rule.burst;
    const before = rule.intervalMs / rule.limit;
    const after = rule.intervalMs / limit;
    rule.ub = Math.max(rule.ub, burst);
    if (rule.algorithm === 'gcra' && after !== before) {
      rebase(rule, now);
      if (after > before) rule.sw = Math.max(rule.sw, now + rule.ub * after);
    }
    rule.limit = limit;
    rule.burst = burst;
  }
  return { changed, relaxed };
}

/** Public snapshot of authoritative rules, with scopes from the shared structure. */
export function snapshot(
  version: string,
  revision: number,
  rules: ReadonlyMap<string, FrameRule>,
  structure: readonly NormalizedRule[],
): LimitsSnapshot {
  const values: Record<string, LimitsSnapshot['rules'][string]> = {};
  for (const rule of structure) {
    const value = rules.get(rule.name!)!;
    values[rule.name!] = Object.freeze({
      algorithm: value.algorithm,
      intervalMs: value.intervalMs,
      limit: value.limit,
      burst: value.burst,
      ...(rule.scope === undefined ? {} : { scope: rule.scope }),
    });
  }
  return Object.freeze({ version, revision, rules: Object.freeze(values) });
}

/** Whether `next` raises any limit or burst over `previous`. */
export function relaxes(previous: LimitsSnapshot, next: LimitsSnapshot) {
  return Object.entries(next.rules).some(([name, rule]) => {
    const before = previous.rules[name];
    return !before || rule.limit > before.limit || rule.burst > before.burst;
  });
}

/** Order snapshots by registration epoch, then revision. Positive when `a` is newer. */
export function compareVersions(a: string, b: string) {
  const [ea, ra] = a.split('.').map(Number) as [number, number];
  const [eb, rb] = b.split('.').map(Number) as [number, number];
  return ea === eb ? ra - rb : ea - eb;
}

/** Real expiry of GCRA state X for the memory store, mirroring immutable expiry in the identity frame. */
export function expiry(rule: FrameRule, x: number, now: number) {
  return (
    now +
    Math.max(
      1,
      Math.ceil(
        identity(rule) ? x - now : (x - theta(rule, now)) * ratio(rule),
      ),
    )
  );
}

/**
 * Grant a prefix of costs under authoritative rules validated by the store's resolver.
 * Mirrors managed.lua.
 * GCRA states are clamped to the largest debt the frame allows, which only
 * affects state written under a different frame.
 * @returns The immutable result shape plus `impossible` when the first ungranted
 * job exceeds a rule's current capacity.
 */
export function managedBatch(
  rules: readonly FrameRule[],
  costs: readonly number[],
  states: RuleState[],
  now: number,
) {
  const thetas = rules.map((rule, i) => {
    if (rule.algorithm !== 'gcra') return 0;
    const t = theta(rule, now);
    states[i]!.a = Math.min(states[i]!.a, t + rule.sr * rule.ub);
    return t;
  });
  let granted = 0;
  let retryAfterMs = 0;
  let impossible = false;
  for (const cost of costs) {
    retryAfterMs = 0;
    if (rules.some((rule) => cost > capacity(rule))) {
      impossible = true;
      break;
    }
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i]!;
      const state = states[i]!;
      if (rule.algorithm === 'gcra') {
        const t = thetas[i]!;
        const excess =
          Math.max(state.a, t) + rule.sr * cost - rule.sr * rule.burst - t;
        if (excess > 0)
          retryAfterMs = Math.max(
            retryAfterMs,
            Math.ceil(excess * ratio(rule)),
          );
      } else {
        const window = Math.floor(now / rule.intervalMs);
        const count = state.a === window ? state.b : 0;
        if (count + cost > rule.limit)
          retryAfterMs = Math.max(
            retryAfterMs,
            Math.ceil((window + 1) * rule.intervalMs - now),
          );
      }
    }
    if (retryAfterMs > 0) break;
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i]!;
      const state = states[i]!;
      if (rule.algorithm === 'gcra') {
        state.a = Math.max(state.a, thetas[i]!) + rule.sr * cost;
        state.expires = expiry(rule, state.a, now);
      } else {
        const window = Math.floor(now / rule.intervalMs);
        state.b = (state.a === window ? state.b : 0) + cost;
        state.a = window;
        state.expires = now + Math.ceil(rule.intervalMs * 2);
      }
    }
    granted++;
  }
  return {
    granted,
    retryAfterMs,
    pausedMs: 0,
    impossible,
  };
}
