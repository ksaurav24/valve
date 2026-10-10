---
'@ksaurav24/valve': patch
---

Redis and Valkey stores now expire GCRA state and global lease sets at absolute times from the same `TIME` reading as admission. Relative TTLs counted from the server's millisecond snapshot could expire a key up to 1ms before its stored time, so a contending process could start slightly before the configured spacing. Requires no configuration change; Redis 6.2 and Valkey 7.2 remain the minimum versions.
