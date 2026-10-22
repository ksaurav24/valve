---
'valvejs': minor
---

Add opt-in runtime updates for existing named rate rules with `limits: 'managed'`, `updateLimits(patch, { expect })`, `getLimits()`, and the `limits` event. Memory and Redis/Valkey stores enforce the committed numeric limits atomically, preserve fixed-window counts and GCRA cost-unit debt, and re-evaluate waiting jobs after increases. Structural changes and concurrency updates still require a coordinated migration.

Add `LIMITS_CONFLICT` for conditional update conflicts. Managed jobs that exceed the current rule capacity reject with `COST_EXCEEDS_LIMIT`; unsafe virtual-time precision fails closed with `INVALID_OPTIONS`. Default immutable behavior is preserved. Managed metadata requires Redis `noeviction`; idle scoped identities can recover at their old expiry after a rate decrease, and failover can lose acknowledged updates. See the runtime limits guide for migration and consistency limits. The additional managed implementation increases the core and Redis bundle sizes.
