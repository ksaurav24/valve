---
'valvejs': minor
---

Add atomic scoped rate limits for requests that spend shared and per-identity budgets together. Named rules select recipient, tenant, or resource counters through per-job `scopes`; memory and Redis/Valkey stores spend every applicable budget or none. Blocked identities wait while other eligible jobs proceed, with priority, weighted costs, cancellation, deadlines, and global concurrency leases.

Fetch wrappers accept fixed identities or a synchronous resolver. Identities are copied once per logical request and reused across retries; every attempt reacquires all budgets. Missing required identities name the missing dimension and reject before queueing. Inactive Redis scope keys expire automatically.

Scoped policies support up to 16 rules and 128 jobs per admission, with a default batch of 32. All keys for one Valve ID share a Redis Cluster slot. Custom stores must implement `acquireScoped`. Rule and scope changes require a coordinated configuration-fingerprint migration; limits cannot vary dynamically per identity. Provider feedback and pauses still affect the whole Valve ID. Admission does not guarantee provider delivery, and exact rolling windows remain unsupported.

Include mixed-algorithm and multi-dimension examples, a Bottleneck chaining comparison, beta migration guidance, correctness tests across memory and Redis/Valkey, and reproducible benchmarks. Larger rule/batch combinations can increase Redis script latency and bundle size; see the scoped benchmark report for measurements and tuning guidance.
