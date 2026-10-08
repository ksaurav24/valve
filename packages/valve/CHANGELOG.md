# @ksaurav24/valve

## 0.1.1

### Patch Changes

- a916f7e: Account for elapsed asynchronous acquisition time when scheduling rate checks
  with local concurrency. Use monotonic elapsed time so local wall-clock changes
  do not distort that adjustment. Every check still requires atomic store admission;
  global concurrency polling, shared pauses, and outage backoff retain their behavior.
- 3606210: Remove positive jitter from rate eligibility waits when concurrency is local.
  Every wakeup still checks atomic store admission. Retain jitter for global
  concurrency polling and store failure backoff.

## 0.1.0

Initial implementation: shared rate rules, memory and Redis/Valkey stores, local concurrency, queue controls, provider feedback, fetch retries, and typed ESM/CommonJS entry points. This version is not published.
