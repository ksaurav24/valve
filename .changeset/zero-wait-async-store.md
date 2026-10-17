---
'valvejs': patch
---

`maxWait: 0` jobs queued behind an in-flight store call now get their admission attempt in a later batch. Previously, with `redisStore` or another asynchronous store, only the first batch reached the store and every other zero-wait job was rejected with `MAX_WAIT_EXCEEDED` without an attempt. Zero-wait jobs are still rejected when the store denies them, local concurrency is full, or newer higher-priority work keeps them out of every batch.
