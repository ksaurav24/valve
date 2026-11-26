---
'valvejs': major
---

Release 1.0.0 with a documented stability contract. See the new Stability and versioning page for what semver covers, how closed unions such as `ValveErrorCode` and `ValveEventMap` evolve, the frozen defaults, and the Redis key layout that 1.x workers share.

Breaking: Node.js 22 or later is required (`engines` was `>=20`; Node.js 20 reached end of life on 2026-04-30). The fallback to `Symbol.for('nodejs.asyncDispose')` for Node.js releases before 20.4 is removed.

Breaking: `Valve.pause`, `Valve.resume`, `Valve.getLimits`, and `Valve.updateLimits` reject asynchronously with `CLOSED` once the valve is closed (matching `ValveGroupMember`), and `Valve.pause` rejects asynchronously with `INVALID_OPTIONS` for invalid durations instead of throwing synchronously. A `0` pause duration is now a no-op.

Fix: `redisStore` now unsubscribes Redis pub/sub channels once their last listener leaves (serializing re-subscription cleanly), preventing unbounded channel and memory growth with dynamic `createValveGroup` keys.

Fix: `Valve.pause` and `Valve.resume` no longer double-emit `pause` or `resume` events on the calling valve when store subscriptions are active, global lease timers clamp delays above the 32-bit `setTimeout` maximum, and `ValveGroupMember.wrapFetch` captures `globalThis.fetch` at wrap time.

Managed limits (`limits: "managed"`, `getLimits`, `updateLimits`, the `limits` event, and the `Limits*` and `Managed*` types) are marked experimental and may change in a minor release.

Document that `Valve.run` can reject with `LEASE_LOST`.
