# runSequential and composing valves

Source: [Compose valves](https://valvejs.vercel.app/docs/guides/compose-valves/).

| Model                                  | If a later budget denies                    |
| -------------------------------------- | ------------------------------------------- |
| One valve with several rules or scopes | Nothing is spent. Atomic.                   |
| Independent keyed groups               | Keys admit independently; no parent budget. |
| `runSequential` or manual nesting      | Earlier admissions stay spent. No refund.   |
| Separate `run` calls per workflow step | Each step admitted when it runs.            |

Prefer the first whenever the budgets belong to one operation.

## Usage

```ts
import { runSequential } from 'valvejs';

export function handle(tenant: string, signal: AbortSignal) {
  // Not atomic: an ingress admission stays spent if the tenant stage denies.
  return runSequential(
    [
      { valve: ingress, options: { cost: 1 } },
      { valve: tenants, options: { scopes: { tenant }, cost: 2, priority: 5 } },
    ],
    ({ signal }) => callProvider(signal),
    { signal },
  );
}
```

- Stages are outermost first; equivalent to `ingress.run(() => tenants.run(fn))`.
- Each stage gets only its own options (`scopes`, `cost`, `priority`,
  `maxWait`, `observe`).
- The shared `signal` cancels whichever stage is waiting. Use
  `AbortSignal.timeout(ms)` for an end-to-end deadline; there is none otherwise.
- Rejects with `INVALID_OPTIONS` before any admission for empty stages, a
  missing valve, a non-function `fn`, or two stages with the same `id`. Stage
  options are validated only when that stage is entered, so validate
  input-derived costs and scopes up front.
- A group member (`tenants.get(key)`) works as a stage.
- Rejections carry the denying stage's `valveId`. The outer valve counts an
  inner rejection as a failed job.

## Pitfalls

- Outer concurrency slots and global leases stay held while inner stages wait:
  head-of-line blocking. Give inner stages a `maxWait`.
- Nest the same valves in the same order everywhere, or single-slot valves can
  deadlock (across processes with global concurrency).
- Never call a stage valve's `run` or `wrapFetch` inside `fn`; it admits again.
- `runSequential` never calls `observe`. Put `observe` in the stage that owns
  the provider quota.
- `updateLimits` on several stages commits separately; no cross-valve atomic
  update.
- Each stage uses its own store and `onStoreError` policy.
