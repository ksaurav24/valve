// Pure atomic batch math mirrored by the Redis Lua implementation.
import type { AcquireResult, NormalizedRule } from './store.js';
export interface RuleState {
  a: number;
  b: number;
  expires: number;
}
export function acquireBatch(
  rules: readonly NormalizedRule[],
  costs: readonly number[],
  states: RuleState[],
  now: number,
): AcquireResult {
  let granted = 0;
  let retryAfterMs = 0;
  for (const cost of costs) {
    retryAfterMs = 0;
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i]!;
      const state = states[i]!;
      if (rule.algorithm === 'gcra') {
        const step = rule.intervalMs / rule.limit;
        retryAfterMs = Math.max(
          retryAfterMs,
          Math.ceil(
            Math.max(state.a, now) + step * cost - step * rule.burst - now,
          ),
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
        state.a =
          Math.max(state.a, now) + (rule.intervalMs / rule.limit) * cost;
        state.expires = now + Math.max(1, Math.ceil(state.a - now));
      } else {
        const window = Math.floor(now / rule.intervalMs);
        state.b = (state.a === window ? state.b : 0) + cost;
        state.a = window;
        state.expires = now + Math.ceil(rule.intervalMs * 2);
      }
    }
    granted++;
  }
  return { granted, retryAfterMs: Math.max(0, retryAfterMs), pausedMs: 0 };
}
