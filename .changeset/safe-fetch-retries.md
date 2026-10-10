---
'@ksaurav24/valve': patch
---

Automatic `wrapFetch()` retries now default to GET, HEAD, OPTIONS, PUT and DELETE.
POST, PATCH and other methods return the first response unless the caller opts
in with `retryUnsafeMethods: true` on a dedicated wrapper after verifying the
provider's idempotency contract. An idempotency key alone does not enable retries.
This changes the previous default that retried every method; setting `retries`
alone no longer enables POST or PATCH replay. Every response still updates shared
cooldowns. `retries: 0` and streamed `init.body` requests continue to disable retries.
