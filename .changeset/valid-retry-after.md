---
'@ksaurav24/valve': patch
---

Validate Retry-After before retrying a 503 response. Malformed or empty values now return the response without retrying or consuming its body. Valid delays, shared pauses, pause caps, and 429 fallback backoff are preserved.
