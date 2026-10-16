---
'valvejs': minor
---

`memoryStore()` now rejects valves that share an id with different rate rules, global concurrency limit, or lease TTL with `INVALID_OPTIONS`, as the Redis store does. Mismatched configurations that previously ran with mixed limits now fail. The memory store also forgets an id's static policy once its rate, lease, and pause state expire, so short-lived ids no longer grow memory without bound.

`ScopedAcquireResult` gains an optional `pausedMs` field. Scoped valves now update `stats().pausedUntil` and emit `pause` when the store reports a shared pause, including Redis stores without a subscriber.

A direct `acquire` that asks for more jobs than free lease slots on an empty slot set now returns the lease TTL as its retry hint. The Redis script previously failed with a Lua error, and the memory store returned `Infinity`.
