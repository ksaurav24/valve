---
'valvejs': patch
---

Reduce redundant scheduler wakeups: use rate timing for rate-blocked global valves, spread asynchronous static banked GCRA retries by up to 25ms within the available bank and queued deadlines, and coalesce release notices while a local release is pending. Strict burst-1 rate bounds and fixed-window admission are unchanged.
