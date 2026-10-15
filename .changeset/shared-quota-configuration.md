---
'@ksaurav24/valve': minor
---

Detect incompatible shared Redis/Valkey quota settings atomically during
admission. A versioned fingerprint without a TTL covers normalized rate rules and
global concurrency settings. Reported mismatches reject with `INVALID_OPTIONS`
under every store-error policy, including `open`. Store outages and timeouts
retain their existing policy behavior. Equivalent rule order and durations
continue to share a budget. Document coordinated quota changes and the limits of
rolling upgrades from versions without the guard. Reliable shared quotas and
mismatch detection require a non-evicting Redis deployment; eviction can remove
the fingerprint or active budget state.
