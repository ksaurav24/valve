# What valve guarantees, and what it does not

Condensed from [Guarantees](https://valvejs.vercel.app/docs/guarantees/). Use
this to keep review findings accurate: don't promise behavior valve does not
provide, and don't flag behavior that is by design.

## Rate bounds

Bounds describe the total cost of jobs **started**, measured on the store's
clock at atomic admission. Not when requests reach the provider, not when they
finish.

| Rule              | Bound                                                                    |
| ----------------- | ------------------------------------------------------------------------ |
| GCRA, `burst: 1`  | At most `limit` units per `interval`, spaced `interval / limit` apart.   |
| GCRA with `burst` | At most `limit + burst - 1` units in any window of length `interval`.    |
| Fixed window      | At most `limit` per aligned window; up to `2 x limit` across a boundary. |
| Several rules     | Each holds independently; checked and spent atomically together.         |

Timers can fire late; valve never catches up by starting closer than the rule
allows. Network delays can still bunch arrivals at the provider.

## Shared pauses

- A pause blocks new grants for the id in every process; grants issued before
  it can still start.
- A pause only extends; `resume()` deletes it.
- `observe()` writes in the background (fire and forget, failure emits
  `store-error`). `await valve.pause()` confirms.
- Without a subscriber, another process's `resume()` is noticed on the next
  store call, possibly at the end of the cached pause.
- Backoff escalation after headerless 429s is per valve instance; the cooldown
  itself is shared.

## Ordering and fairness

Higher priority first within one valve, call order for ties. No ordering or
fairness across processes. Queues are local and in memory: queued jobs are lost
if the process exits. Use a durable job queue for work that must survive.

## Concurrency

Counts jobs, not cost. Global leases renew every `leaseTtl / 3` and expire after
`leaseTtl` if a worker dies. On lease loss the job signal aborts and the job
rejects with `LEASE_LOST`. A process stalled past its TTL can still perform
effects; use fencing tokens in the external system for strict bounds. No
exactly-once guarantee.

## Cancellation and timeouts

A job cancelled while its acquire is in flight does not run, but its grant is
spent. A timed-out Redis call can spend budget after valve gave up. Both reduce
throughput, neither raises the rate (under `wait` or `throw`).

## Store failures

| `onStoreError`     | While the store is down                                        |
| ------------------ | -------------------------------------------------------------- |
| `'wait'` (default) | Jobs stay queued and retry with backoff until their `maxWait`. |
| `'throw'`          | Affected jobs reject with `STORE_UNAVAILABLE`.                 |
| `'open'`           | Jobs run without shared rules. Rate bounds do not hold.        |

A configuration mismatch reported by Redis rejects with `INVALID_OPTIONS` under
every policy.

## Store state loss

If Redis loses valve's keys (flush, restart without persistence, eviction,
failover to a lagging replica), budgets start fresh and pauses end, silently.
valve cannot detect lost rate history. The provider's own enforcement is the
final hard limit.

## Out of scope by design

- Exact rolling-window quotas.
- Persisting queued jobs, retrying arbitrary failures, circuit breaking.
- Cross-process fairness or priority.
- Inbound rate limiting of your own server.
- Atomic admission across separate valve ids (groups and `runSequential` are
  not atomic; scoped rules inside one valve are).
