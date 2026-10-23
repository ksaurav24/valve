// Explicit, non-atomic composition of independent valves, outermost first.
import { invalid } from './errors.js';
import type { JobContext, RunOptions, Valve } from './types.js';

/** One admission step for {@link runSequential}.
 * @example const stage: SequentialStage = { valve: ingress, options: { cost: 1 } };
 */
export interface SequentialStage<T = unknown> {
  /** The valve that admits this stage. Every stage needs a different `id`. */
  readonly valve: Valve;
  /**
   * Options for this stage only. Nothing is copied between stages. The shared
   * signal comes from {@link RunSequentialOptions}. `observe` feeds this
   * stage's valve only, with the final result.
   */
  readonly options?: Omit<RunOptions<T>, 'signal'>;
}

/** Options shared by every stage of {@link runSequential}.
 * @example const options: RunSequentialOptions = { signal: AbortSignal.timeout(5000) };
 */
export interface RunSequentialOptions {
  /**
   * Cancels whichever stage is waiting. Later stages and `fn` receive the
   * signal of the job that admitted them, which aborts with this one and,
   * for a global stage, when its lease is lost. Admissions already granted by
   * earlier stages stay spent.
   */
  readonly signal?: AbortSignal;
}

/**
 * Runs `fn` after each valve admits it in turn, outermost first. Equivalent to
 * `a.run(() => b.run(fn))`, with each stage's own options.
 *
 * Not atomic. An earlier stage's admission stays spent when a later stage
 * rejects, times out, or is aborted, and nothing is refunded. Each earlier job
 * stays running, holding its concurrency slot or global lease, while later
 * stages wait. Each stage applies its own `maxWait`; there is no end-to-end
 * deadline. Use one valve with several rules or scopes when every budget must
 * be spent together or not at all.
 *
 * Never closes a stage valve or its store.
 *
 * @param stages Valves outermost first, each with its own options.
 * @param fn Runs once every stage admits. Receives the innermost job's signal.
 * @param options Signal shared by every stage.
 * @returns Resolves or rejects with whatever `fn` resolves or rejects with.
 * @throws never synchronously. Rejects with `INVALID_OPTIONS` for no stages,
 * a stage without a valve, repeated valve ids, or a non-function `fn`, before
 * any stage admits. Otherwise rejects with the first stage rejection, whose
 * `valveId` names the stage.
 * @example
 * const result = await runSequential(
 *   [
 *     { valve: ingress, options: { cost: 1 } },
 *     { valve: tenantBudget, options: { scopes: { tenant }, priority: 5 } },
 *   ],
 *   ({ signal }) => fetch(url, { signal }),
 *   { signal: request.signal },
 * );
 */
export function runSequential<R>(
  stages: readonly SequentialStage<Awaited<R>>[],
  fn: (ctx: JobContext) => R,
  options?: RunSequentialOptions,
): Promise<Awaited<R>> {
  return new Promise<Awaited<R>>((resolve) => {
    if (!Array.isArray(stages) || stages.length === 0)
      invalid(
        undefined,
        'runSequential needs at least one stage',
        stages,
        'Pass an array of { valve, options }, outermost first',
      );
    if (typeof fn !== 'function')
      invalid(
        undefined,
        'runSequential job must be a function',
        fn,
        'Pass a function to run after every stage admits',
      );
    // Snapshot stages so later caller mutation cannot bypass validation.
    const ids = new Set<string>();
    const list: { valve: Valve; own: RunOptions<Awaited<R>> }[] = [];
    for (const stage of stages) {
      const valve = (stage as SequentialStage | undefined)?.valve;
      if (typeof valve?.run !== 'function')
        invalid(
          undefined,
          'each runSequential stage needs a valve',
          valve,
          'Pass { valve, options } for every stage',
        );
      // With a shared store, a nested job on its own id waits on budget,
      // concurrency, or leases its outer job holds, and charges one budget
      // twice. Ids are rejected even across stores, conservatively.
      if (ids.has(valve.id))
        invalid(
          valve.id,
          'runSequential stages must use different valve ids',
          valve.id,
          'Use one stage with a higher cost to charge one budget more',
        );
      ids.add(valve.id);
      // Untyped callers cannot add a stage signal of their own.
      const own: RunOptions<Awaited<R>> = { ...stage.options };
      delete own.signal;
      if (own.scopes) own.scopes = { ...own.scopes };
      list.push({ valve, own });
    }
    // Each stage gets its outer job's signal: the shared signal, or a lease
    // signal derived from it that also aborts if an outer global lease is lost.
    const enter = (
      index: number,
      signal: AbortSignal | undefined,
    ): Promise<Awaited<R>> => {
      const { valve, own } = list[index]!;
      const runOptions: RunOptions<Awaited<R>> = signal
        ? { ...own, signal }
        : own;
      if (index === list.length - 1) return valve.run(fn, runOptions);
      return valve.run<Promise<Awaited<R>>>(
        (ctx: JobContext) => enter(index + 1, ctx.signal),
        runOptions,
      );
    };
    resolve(enter(0, options?.signal));
  });
}
