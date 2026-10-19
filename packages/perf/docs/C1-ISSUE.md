# C1 issue: callbacks can start after their `maxWait` deadline

Status: filed as [ksaurav24/valve#100](https://github.com/ksaurav24/valve/issues/100) at the user’s request.
The issue includes a standalone reproducer and verified memory, Redis, and Valkey results.
The performance harness does not change Valve production code.

## Summary

Valve can start a callback after the deadline established by `maxWait`. The store response is
checked against the deadline, but granted callbacks are scheduled in later microtasks. If an
earlier callback in the same granted batch performs synchronous work, a later callback can cross
its deadline between the check and its actual start.

This is a safety issue, not a latency percentile or performance regression. The required
invariant is: a callback whose monotonic start time is later than `submit + maxWait` must not run.

## Reproduction

```sh
pnpm install --frozen-lockfile
pnpm --filter valvejs build
pnpm perf c1
```

The deterministic reproducer uses a granted batch whose first callback blocks synchronously past
the next job's deadline. It exercises memory and Redis paths. The expected report label is
`KNOWN DEFECT REPRODUCED`, with safety `FAIL (C1 × n)` and the worst lateness recorded.

An expected-failure test may keep CI green while the defect remains. That green check means the
known behavior was reproduced; it must not be described as a safety pass.

## Classification

- `C1-check-before-deadline`: the grant reply was handled before the deadline, but the callback
  began after it.
- `late-grant`: the grant reply was handled after the deadline and the callback still began.

Both classifications make the arm's absolute safety status `FAIL`. Performance conclusions are
reported separately and cannot override that status.

## Expected behavior

Immediately before invoking each callback, Valve should check the same monotonic deadline used by
the client oracle. A job that has crossed its deadline should settle with the documented timeout
outcome and its callback should never begin. Any proposed fix needs focused tests for multi-grant
batches, synchronous earlier callbacks, event-loop stalls, memory and Redis stores, abort races,
and equality at the deadline.

## Scope and evidence to attach before filing

Attach the complete `.perf/runs/<runId>/` directory or its CI artifact, including the manifest,
build identity, environment fingerprint, raw events, and rendered report. Include the exact
Valve commit and distinguish forced lateness from naturally observed lateness.

The RFC records earlier evidence of forced 21-26 ms lateness and three natural cases no worse
than 0.26 ms. Those historical observations require their archived provenance when quoted. Run
the current reproducer before filing so the issue does not rely only on historical numbers.

## Non-goals

This document does not choose or implement a production fix or change `maxWait` semantics.
Fix design and compatibility review belong in a separate change.
