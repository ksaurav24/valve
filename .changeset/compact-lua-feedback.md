---
'@ksaurav24/valve': patch
---

Minify embedded Redis Lua at build time and allow unused default feedback readers to be tree-shaken. Paired Node 24 measurements reduce the published Redis ESM bundle from 3,521 to 3,151 gzip bytes (10.5%) and a `retryAfter()` consumer from 1,089 to 445 bytes (59.1%).

Public exports, types, store behavior, and zero runtime/peer dependencies are preserved. Core size is unchanged; no general startup, throughput, or latency improvement is claimed. The benchmark recommendation and footprint report document the regression controls, remaining size targets, and build-time trade-offs.
