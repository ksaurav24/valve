// Admission state only: no scheduler, sockets, timers, or ambient clock.
/** Normalized rule; keys identify independent budgets (default: positional index). */
export interface Rule {
  algorithm: 'gcra' | 'fixed-window';
  intervalMs: number;
  limit: number;
  burst: number;
  key?: string;
}
/** Redis string state, absent once now >= ceil(tat). */
export interface GcraState {
  kind: 'gcra';
  tat: number;
  expiresAt: number;
}
/** Redis hash state; static TTL is 2*interval, scoped expiry is next window. */
export interface WindowState {
  kind: 'fixed-window';
  w: number;
  n: number;
  expiresAt: number;
}
/** One quota domain; callers explicitly own and mutate this state. */
export interface AdmissionState {
  rules: Map<string, GcraState | WindowState>;
  leases: Map<string, number>;
  untilMs: number;
}
/** Make an empty quota domain. */
export function createState(): AdmissionState {
  return { rules: new Map(), leases: new Map(), untilMs: 0 };
}
/** Copy a snapshot, including all maps, for independent counterfactuals. */
export function cloneState(state: AdmissionState): AdmissionState {
  return {
    rules: new Map([...state.rules].map(([k, v]) => [k, { ...v }])),
    leases: new Map(state.leases),
    untilMs: state.untilMs,
  };
}
/** Drop expired keys and lease members; expiry equality removes ownership. */
export function expire(state: AdmissionState, now: number): void {
  for (const [key, value] of state.rules)
    if (value.expiresAt <= now) state.rules.delete(key);
  for (const [token, end] of state.leases)
    if (end <= now) state.leases.delete(token);
}
/** Identity of a normalized rule in a request. */
export function ruleKey(rule: Rule, index: number): string {
  return rule.key ?? String(index);
}
