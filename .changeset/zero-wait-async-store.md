---
'valvejs': patch
---

`maxWait: 0` jobs queued behind an in-flight store call now wait for the valve to send another batch instead of being rejected right away. Previously, with `redisStore` or another asynchronous store, only the first batch reached the store and every other zero-wait job was rejected with `MAX_WAIT_EXCEEDED` without an attempt. Zero-wait jobs still reject with `MAX_WAIT_EXCEEDED` when the store denies them. They reject without an attempt when the valve sends no further batch (after a rate denial, a pause, or a store outage, or with local concurrency full) or when newer higher-priority work keeps them out of every batch.
