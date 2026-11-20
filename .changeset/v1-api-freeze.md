---
'valvejs': major
---

Release 1.0.0 with a documented stability contract. See the new Stability and versioning page for what semver covers, how closed unions such as `ValveErrorCode` and `ValveEventMap` evolve, the frozen defaults, and the Redis key layout that 1.x workers share.

Breaking: Node.js 22 or later is required (`engines` was `>=20`; Node.js 20 reached end of life on 2026-04-30). The fallback to `Symbol.for('nodejs.asyncDispose')` for Node.js releases before 20.4 is removed.

Managed limits (`limits: "managed"`, `getLimits`, `updateLimits`, the `limits` event, and the `Limits*` and `Managed*` types) are marked experimental and may change in a minor release.

Document that `Valve.run` can reject with `LEASE_LOST`.
