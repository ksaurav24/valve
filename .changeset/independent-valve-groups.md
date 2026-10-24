---
'valvejs': minor
---

Add `createValveGroup` in the new `valvejs/group` entry for independent keyed valves on one shared store. Each key maps to the stable id `${id}:${encodeURIComponent(key)}`, so workers sharing a store share one budget per key, and different keys never share budgets, cooldowns, or concurrency. A per-key resolver snapshots configuration on first local use, and managed limits stay authoritative across eviction. A bounded cache (`maxSize`, `idleTtl`) plus bounded pending calls (`maxPending`) never evicts busy valves, evicts paused idle valves only when room is needed (their shared pause stays in the store), and rejects calls needing a new valve with `QUEUE_FULL` when every valve is busy.
