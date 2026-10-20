# C1: callback invocation after maxWait

[Issue #100](https://github.com/ksaurav24/valve/issues/100) was fixed by
[PR #101](https://github.com/ksaurav24/valve/pull/101), included in valvejs 0.5.2.
The harness consumes the upstream fix and keeps the regression probe.

## Original behavior

In valvejs 0.5.0, Valve checked a positive `maxWait` deadline when processing admission, then
invoked the callback in a later microtask. An earlier synchronous callback in the same batch
could block through the later job's deadline. The later callback still ran and fulfilled.

The issue includes a standalone public-API reproducer and verified memory, Redis 7.4, and
Valkey 8 observations. Deliberately forced lateness was about 30-31 ms. These observations do
not estimate the natural frequency of the defect.

## Regression command

```sh
pnpm perf c1 --stores memory,redis74,valkey8
```

Redis/Valkey names must refer to registered harness-owned disposable stores. With no store
option, the command checks memory and the first registered Redis-compatible store, if any.

| Result     | Required observation                                                                                                        | Exit |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- | ---- |
| PASS       | The first job finishes and blocks through the later deadline; the later job rejects with MAX_WAIT_EXCEEDED without starting | 0    |
| FAIL       | A callback starts after its positive maxWait deadline                                                                       | 1    |
| UNVERIFIED | Unrelated rejection, missing blocking interval, or another incomplete observation                                           | 2    |

Setup errors also exit 2. Every result records the build/environment identity, exact rejection
code, blocking condition, and safety status. `report <runId> --html` preserves these statuses.
Historical failures remain failures; old incomplete observations never become safety passes.

## Fixed production behavior

Valve checks expiry immediately before callback invocation. Expired or cancelled callbacks are
skipped, reserved concurrency and leases are released, and skipped callbacks are not counted
as started. `maxWait: 0` retains its separate single-attempt semantics.

The harness unit suite verifies the fixed memory path. Its real-store integration suite and
C1 command verify Redis/Valkey paths. The oracle continues to classify every late callback as
an absolute safety failure and stops a real-time run on deadline violations.
