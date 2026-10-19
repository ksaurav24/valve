---
'valvejs': patch
---

Check positive maxWait deadlines immediately before invoking callbacks, including jobs admitted in the same batch. Skip expired or cancelled callbacks and release their reserved concurrency slots and global leases without counting them as started. Preserve maxWait: 0 as a single immediate admission attempt.
