---
name: valve-quota-design
description: 'Model layered, scoped, or independent quotas with valvejs, including tenant tiers, keyed groups, global concurrency, and managed runtime limits. Use when choosing a quota structure or changing an existing shared policy.'
license: Apache-2.0
---

# Design quotas with valve

A valve `id` names one budget in the store. Everything in this skill is about
mapping the provider's real enforcement onto ids and rules so that:

- traffic that spends one provider quota shares one budget,
- traffic with independent quotas does not block each other,
- a request that must satisfy several quotas is admitted only when all allow it,
- 429 feedback pauses exactly the traffic it should.

Get the provider's documented limits and **what each one is keyed by**
(credential, account, endpoint, model, recipient, tenant) before choosing a
shape. If you cannot confirm, state your assumption in the code and summary.

## Decision guide

Ask these in order; the first match is usually right.

1. **Several quotas, all applying to every request on one credential** (for
   example 10/s and 100,000/day)? One valve, an array of rules. Each job spends
   its `cost` from every rule atomically.

2. **Independent quotas per endpoint, resource, or model**, and each request
   spends only one of them? Separate ids, one valve per quota, same store.
   Route each request to its valve. A 429 on one does not pause the others.

3. **One request spends a shared quota and a per-key quota** (account-wide
   throughput plus per-recipient spacing, or a hard tenant-wide cap plus
   per-user limit)? One valve with **scoped rules**: named rules with a
   `scope`, identities passed per job with `scopes`. Admission is atomic: a
   blocked recipient spends nothing from the shared budget, and other
   recipients keep flowing. Read [references/scoped-rules.md](references/scoped-rules.md).

4. **Many keys (tenants, customer credentials, models) with their own quota,
   tier, concurrency, or cooldown, and no shared parent quota across keys**?
   An **independent keyed group**: `createValveGroup` from `valvejs/group`.
   `resolve(key)` returns per-key options, idle keys are evicted, store state
   survives. Read [references/groups.md](references/groups.md).

5. **Two separate budgets that must both admit, and the first charge should
   stand even if the second denies** (an ingress or abuse counter that counts
   every attempt)? `runSequential` over separate valves. It is not atomic;
   say so in a comment. Read [references/sequential.md](references/sequential.md).

6. **A workflow calls provider A, transforms, then calls provider B**? Separate
   `run` calls at each step. Don't nest them, which would hold A's slot while
   waiting for B.

7. **The provider caps in-flight requests across the fleet**? Add
   `concurrency: { limit, scope: 'global' }` (shared store required).
   A number is per process only.

8. **Limits change while workers run** (plan upgrades, provider changes,
   per-tenant upgrades)? `limits: 'managed'` with named rules, then
   `updateLimits`. Read [references/managed-limits.md](references/managed-limits.md).

Combinations are normal: a group whose resolver returns scoped rules, managed
limits inside a group, layered rules plus global concurrency.

### Common wrong turns

- Splitting one credential-wide quota into per-endpoint or per-tenant ids. Each
  gets a full budget; together they exceed the provider limit, and a 429 on one
  does not pause the others.
- Merging independent quotas under one id. One 429 pauses unrelated traffic and
  one budget throttles both.
- Using a group, or nesting `run` calls, when a request must spend a hard parent
  quota and a per-key quota together. Neither is atomic across ids; use scoped
  rules in one valve.
- Expecting per-identity limits from scoped rules. Every identity of a scoped
  rule gets the same `limit`/`burst`. Different tiers per key means a group.
- Expecting feedback per scope. `observe`, `wrapFetch` feedback, and `pause()`
  apply to the whole valve id, so a 429 for one recipient pauses all recipients
  of that valve. If cooldowns must be per key, the keys need separate ids
  (group or separate valves).
- Raw secrets or PII as ids, scope values, or group keys. They become Redis key
  names. Use opaque ids or a keyed hash, stable on every worker.

## Rule mechanics to keep in mind

- GCRA (default) paces at `interval / limit` per unit, `burst` (default 1)
  units back to back. Fixed window: `limit` per epoch-aligned window (UTC),
  up to `2 x limit` across a boundary. No exact rolling windows.
- `cost` must be `<= burst` (GCRA) and `<= limit` (fixed window) for every rule
  in the valve.
- Unnamed rules cannot share algorithm and interval; scoped and managed rules
  need `name`. Names and scope dimension names: letters, digits, `_`, `-`,
  starting with a letter, up to 64 chars.
- Scoped valves: at most 16 rules; `batch` at most 128 (default 32).
- Monthly quotas: no calendar months. Approximate with a daily rule, or track
  in application code.

## Changing a policy that is already in production

Under the default immutable mode, Redis pins a fingerprint of each id's rules
and global concurrency. Any change to names, scopes, algorithm, interval,
`limit`, `burst`, or global lease settings makes mismatched workers reject jobs
with `INVALID_OPTIONS`. This is a safety feature, not a bug to work around.

- Numeric `limit`/`burst` changes on named rules: use managed limits and
  `updateLimits` (no redeploy, no reset).
- Anything structural, or numeric changes in immutable mode: follow
  [references/changing-policy.md](references/changing-policy.md) (drain all
  workers, let budgets recover, delete only the config key, start the new
  policy everywhere).
- Never delete rate keys, flush Redis, or switch to a new id or prefix while
  old workers run to "reset" a spent budget; that admits over the provider's
  limit.

## Deliverable

When you design or change a quota model, give the user:

1. A short table: each provider quota, what it is keyed by, and the valve
   construct that enforces it (id, rule name, scope, group key).
2. The code, with limits in named constants traced to the provider docs.
3. The trade-offs that apply (non-atomic stages, whole-id feedback, cluster
   slot locality, cold-identity behavior for managed scoped decreases).
4. Rollout notes if an existing policy changes.

For anything not covered here, see
<https://valvejs.vercel.app/docs/guides/provider-quota-scopes/> and the
neighboring guides.
