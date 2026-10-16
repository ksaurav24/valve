---
'valvejs': patch
---

With global concurrency, `close()` now waits up to `leaseTtl` for an in-flight store admission and releases any leases it grants, so a shutdown no longer strands slots until their TTL. `close({ drain: true })` lets accepted `wrapFetch` requests finish their retries. When a retry cannot be queued, because the valve closed without draining or `maxQueue` is full, `wrapFetch` returns the rate limit response unread instead of rejecting. Errors from `wrapFetch` `cost`, `priority`, and `scopes` resolvers now count as rejections and emit `reject`.
