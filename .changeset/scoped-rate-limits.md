---
'valvejs': minor
---

Add atomic scoped rate limits through named rules and per-job identities. Memory and Redis stores support sparse admission, and the scheduler lets eligible identities proceed while others wait. Fetch wrappers resolve identities once across retries. Include bounded request validation, policy compatibility checks, tests, benchmarks, and operational guidance. Existing static admission remains on its original store path; feedback and pauses remain Valve-wide.
