# Changing a shared quota policy

Source: [Share a quota: configuration drift](https://valvejs.vercel.app/docs/guides/share-a-quota/#configuration-drift).

## Why INVALID_OPTIONS appears after a deploy

The first admission for an id pins a fingerprint at `PREFIX:{ID}:config` (no
TTL). Immutable mode covers rule names and scope dimensions, algorithm,
interval, limit, burst, plus global concurrency scope, limit, and lease TTL.
Managed mode pins only structure. Every admission checks it atomically. A
worker whose config differs gets `INVALID_OPTIONS` for its jobs under every
`onStoreError` policy; its callbacks never run. Compatible workers keep going.

Safe without migration: reordering identical rules, equivalent durations
(`'1s'` vs `1000`), local settings (local concurrency, `maxQueue`, `maxWait`),
changing identity values, normal inactive-scope expiry.

## Pick the path

| Change                                                    | Path                                                 |
| --------------------------------------------------------- | ---------------------------------------------------- |
| `limit` or `burst` of a named rule, valve already managed | `updateLimits`; no migration                         |
| Same, but the valve is immutable                          | Migrate to managed (below), or coordinated migration |
| Add, remove, or rename a rule or scope dimension          | Coordinated migration                                |
| Change algorithm or interval                              | Coordinated migration                                |
| Change global concurrency limit or `leaseTtl`             | Coordinated migration                                |
| Change id or prefix                                       | Coordinated migration (it is a new budget)           |

## Coordinated migration

1. Stop producers and drain **every** worker using this Redis database, prefix,
   and id (`await valve.close({ drain: true })`). Disable restarts of old
   workers. Make sure outbound jobs actually finished, including ones whose
   leases expired. A store pause alone does not stop already-issued grants.
2. Let outstanding Redis commands settle and close the old clients.
3. Wait until old `PREFIX:{ID}:r:*` and scoped `PREFIX:{ID}:s:*` rate keys have
   expired and the provider quota has recovered. GCRA debt can exceed one
   interval when `burst > limit`. Confirm `PREFIX:{ID}:leases` is empty or
   expired. Leave any provider cooldown in place.
4. Delete only the config key from an administrative connection:

   ```sh
   redis-cli -u "$REDIS_URL" DEL 'valve:{hubspot:portal-123}:config'
   ```

5. Start all workers with the new settings. The first admission pins the new
   fingerprint. Run one job and confirm no `INVALID_OPTIONS`.

Never delete the config key while workers are active. Changing prefix or id
creates an independent budget; overlapping old and new workers can exceed the
provider quota, so it needs the same drain and recovery.

## Rule-specific notes

- **Add a scoped rule**: every producer must supply the new identity at the
  cutover. Stage the code behind a gate, switch policy and callers together.
  Old policies reject extra dimensions; new ones reject missing ones.
- **Rename a rule or dimension**: a name selects state keys; a rename starts a
  fresh counter. Update every worker config and every caller's `scopes`.
- **Remove a rule**: remove the identity from callers only if no other rule
  uses that dimension. Wait for the old quota to recover first.

## Move an immutable valve to managed limits

A managed worker can adopt an existing immutable policy without resetting spent
budget when its complete rules match and every rule is named. Roll out
`limits: 'managed'` with identical rules, then drain every remaining immutable
worker, then run the first `updateLimits`. If the existing rules are unnamed,
adding names is a structural change: use the coordinated migration.

## Upgrading old valve versions

Versions before 0.4.0 do not check the fingerprint. Upgrade with unchanged
settings first; detection is complete once every worker runs a guarded version.
