---
'valvejs': patch
---

`ietfRateLimit()` and `defaultFeedback` now split `RateLimit` fields in linear time and ignore fields longer than 8192 characters, so a malformed header can no longer stall the event loop. Quoted strings may contain escaped quotes and commas. Valves also register their disposer under `Symbol.for('nodejs.asyncDispose')` on Node 20 releases that lack `Symbol.asyncDispose`, so `await using` works across the supported Node 20 range.
