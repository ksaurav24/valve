---
'@ksaurav24/valve': patch
---

Remove positive jitter from rate eligibility waits when concurrency is local.
Every wakeup still checks atomic store admission. Retain jitter for global
concurrency polling and store failure backoff.
