---
'valvejs': patch
---

Keep equal-priority jobs in call order when the store denies part of a batch, and keep `wrapFetch` retries at their original queue position. Denied jobs and retries were previously appended behind later submissions.
