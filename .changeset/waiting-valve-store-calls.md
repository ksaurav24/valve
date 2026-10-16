---
'valvejs': minor
---

Waiting global valves call the store far less often. `AcquireResult` and scoped `blocked` entries gain an optional `leaseBlocked` field, which the memory and Redis stores set on lease requests, so a valve waits out rate denials for the full retry hint instead of polling every 50ms. Lease waits poll every 50ms only without a subscriber, and at least once a second with one. Release notices are coalesced and answered after a short random delay that widens for valves that keep losing slots, so one release no longer sends every waiting valve to the store at once. A valve no longer polls right after its own job settles, before its lease is released. Aborts and `maxWait` expiries no longer cut short the store outage backoff under `onStoreError: 'wait'`.
