/** Runner and raw result projection for T0 microbenchmarks. */

import { microSuites } from './suites.ts';

/** One raw tinybench result, with latency converted from milliseconds to nanoseconds. */
export interface MicroResult {
  suite: string;
  task: string;
  opsPerSec: number;
  nsPerOp: number;
  p50: number;
  p99: number;
  rme: number;
  samples: number;
}

/** Run selected T0 suites and return their unadjusted tinybench statistics. */
export async function runMicro(opts: {
  quick: boolean;
  valveModuleUrl: string;
  filter?: string;
}): Promise<MicroResult[]> {
  const suites = await microSuites(opts);
  const matches = (suite: string, task: string) =>
    opts.filter === undefined || `${suite}/${task}`.includes(opts.filter);

  const output: MicroResult[] = [];
  for (const suite of suites) {
    for (const task of [...suite.tasks]) {
      if (!matches(suite.name ?? '', task.name)) suite.remove(task.name);
    }
    if (suite.tasks.length === 0) continue;
    await suite.run();
    for (const task of suite.tasks) {
      const result = task.result;
      if (result?.state !== 'completed') {
        throw new Error(
          `Microbenchmark ${suite.name}/${task.name} did not complete`,
        );
      }
      output.push({
        nsPerOp: result.latency.mean * 1_000_000,
        opsPerSec: result.throughput.mean,
        p50: result.latency.p50 * 1_000_000,
        p99: result.latency.p99 * 1_000_000,
        rme: result.latency.rme,
        samples: result.latency.samplesCount,
        suite: suite.name ?? '',
        task: task.name,
      });
    }
  }
  return output;
}
