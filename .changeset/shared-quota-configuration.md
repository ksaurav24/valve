---
'@ksaurav24/valve': minor
---

Detect incompatible shared Redis/Valkey quota settings atomically during
admission. A persistent versioned fingerprint covers normalized rate rules and
global concurrency settings. Reported mismatches reject with `INVALID_OPTIONS`
under every store-error policy, including `open`. Store outages and timeouts
retain their existing policy behavior. Equivalent rule order and durations
continue to share a budget. Document coordinated quota changes and the limits of
rolling upgrades from versions without the guard.
