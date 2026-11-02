# INVALID_OPTIONS from configuration drift

Source: [Configuration drift](https://valvejs.vercel.app/docs/guides/share-a-quota/#configuration-drift).

## Recognize it

Jobs (not `createValve`) reject with `INVALID_OPTIONS` and a message describing
an incompatible configuration for the id. It usually appears right after a
deploy that changed rules, global concurrency, or rule names, while some
workers still run the old settings, or after one worker reads different env or
config values.

Redis pinned the first worker's fingerprint at `PREFIX:{ID}:config` (no TTL):
in immutable mode, names, scope dimensions, algorithm, interval, limit, burst,
and global concurrency scope/limit/lease TTL; in managed mode, only structure.
Mismatched workers are rejected under every `onStoreError` policy; their
callbacks never run. There is no separate `CONFIG_MISMATCH` code.

## Diagnose

```sh
redis-cli -u "$REDIS_URL" GET 'valve:{<id>}:config'   # default prefix is "valve"
```

Compare with each deployment's rules (rule order and `'1s'` vs `1000` do not
matter; local settings like `maxQueue` and local concurrency do not matter).

## Fix

- **Unintended difference** (one service has a stale constant or env var):
  make every worker use the same rules. Nothing to delete.
- **Intended numeric change on a managed valve**: use `updateLimits`, not a
  config edit.
- **Intended change otherwise**: a coordinated migration. Drain every worker for
  that id, wait for old rate keys to expire and the provider quota to recover,
  delete only `PREFIX:{ID}:config`, start every worker with the new settings.
  Details:
  <https://valvejs.vercel.app/docs/guides/share-a-quota/#changing-a-shared-quota>.

Do not delete the config key, rate keys, or flush Redis while workers are
running, and do not switch to a new id or prefix to dodge the error. Each
resets or splits the budget and can exceed the provider's quota.

## After a managed update

Once a managed update commits, immutable workers for that id reject with
`INVALID_OPTIONS` by design. Move them to `limits: 'managed'` with the same
named rules.
