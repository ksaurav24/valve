---
'valvejs': patch
---

`maxWait: 0` now runs a job when its first admission attempt is granted and rejects it with `MAX_WAIT_EXCEEDED` otherwise. Previously every such job was rejected, even with free capacity. `redisStore` now rejects a `timeout` below 1ms with `INVALID_OPTIONS`, since a zero timeout failed every store call.
