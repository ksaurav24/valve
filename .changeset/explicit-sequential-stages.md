---
'valvejs': patch
---

Add `runSequential` for explicit, non-atomic composition of independent valves. Stages admit outermost first, each with its own run options and a shared abort signal. Earlier admissions stay spent when a later stage rejects, and outer jobs keep their concurrency slots and global leases while later stages wait.
