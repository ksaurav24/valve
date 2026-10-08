---
'@ksaurav24/valve': patch
---

Account for elapsed asynchronous acquisition time when scheduling rate checks
with local concurrency. Use monotonic elapsed time so local wall-clock changes
do not distort that adjustment. Every check still requires atomic store admission;
global concurrency polling, shared pauses, and outage backoff retain their behavior.
