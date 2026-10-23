---
'valvejs': minor
---

Add `createValveGroup` in the new `valvejs/group` entry for independent keyed valves on one shared store. Each key maps to the stable id `${id}:${encodeURIComponent(key)}`, so the same key shares one budget across workers and different keys never share budgets, cooldowns, or concurrency. A per-key resolver runs once per local valve, managed limits stay authoritative across eviction, and a bounded cache (`maxSize`, `idleTtl`) never evicts busy or paused valves; when every valve is busy, calls needing a new one reject with `QUEUE_FULL`.
