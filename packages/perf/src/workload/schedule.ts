// Offered demand, precomputed from seeds before a trial starts. Open-loop arrival times never
// depend on system responses (no coordinated omission). Job attributes come from a separate
// per-worker stream so every arm sees the same sequence of jobs.
import { Cohort } from '../core/types.ts';
import type { ArrivalSpec, CellSpec, WorkloadSpec } from '../core/types.ts';
import {
  choose,
  deriveSeed,
  exponential,
  mulberry32,
  sample,
  zipf,
  type Random,
} from '../core/rng.ts';

export interface JobAttrs {
  cost: number;
  /** Execution time of the job body, ms (0 for noop). */
  durationMs: number;
  maxWaitMs?: number;
  priority?: number;
  /** Abort this long after submission. */
  abortAfterMs?: number;
  scopes?: Record<string, string>;
  fail?: boolean;
}

export interface Arrival extends JobAttrs {
  /** Intended arrival, ms after the measurement epoch. */
  at: number;
  cohort: number;
}

/** Deterministic job-attribute stream for one worker and cohort. */
export class AttrStream {
  private rnd: Random;
  constructor(
    private workload: WorkloadSpec,
    seed: number,
    worker: number,
    cohort: number,
  ) {
    this.rnd = mulberry32(deriveSeed(seed, 'attrs', worker, cohort));
  }
  next(): JobAttrs {
    const { job, deadlines, abort } = this.workload;
    const r = this.rnd;
    const cost = job.costs
      ? job.costs.values[choose(r, job.costs.weights)]!
      : 1;
    const durationMs =
      job.kind === 'noop' || !job.duration ? 0 : sample(r, job.duration);
    const attrs: JobAttrs = { cost, durationMs };
    if (deadlines?.maxWaitMs !== undefined && r() < (deadlines.fraction ?? 1))
      attrs.maxWaitMs = deadlines.maxWaitMs;
    if (abort && r() < abort.fraction)
      attrs.abortAfterMs = sample(r, abort.after);
    if (job.scopes) {
      attrs.scopes = {};
      for (const s of job.scopes)
        attrs.scopes[s.dimension] =
          `${s.dimension}-${zipf(r, s.identities, s.skew ?? 0)}`;
    }
    if (job.failRate && r() < job.failRate) attrs.fail = true;
    return attrs;
  }
}

/** Open-loop arrival times (ms after epoch, within [0, windowMs)) for one worker. */
export function arrivalTimes(
  arrival: ArrivalSpec,
  workers: number,
  worker: number,
  windowMs: number,
  rnd: Random,
  maxArrivals = 250000,
): number[] {
  const out: number[] = [];
  const push = (t: number) => {
    if (out.length >= maxArrivals)
      throw new Error(
        'offered schedule recording budget exceeded; reduce rate or duration',
      );
    out.push(t);
  };
  const poisson = (ratePerSec: number, from = 0, to = windowMs) => {
    if (ratePerSec <= 0) return;
    const mean = 1000 / ratePerSec;
    for (
      let t = from + exponential(rnd, mean);
      t < to;
      t += exponential(rnd, mean)
    )
      push(t);
  };
  switch (arrival.kind) {
    case 'backlog':
    case 'clients':
      return out;
    case 'poisson':
      poisson(arrival.ratePerSec / workers);
      break;
    case 'periodic': {
      const gap = 1000 / (arrival.ratePerSec / workers);
      for (let t = rnd() * gap; t < windowMs; t += gap) push(t);
      break;
    }
    case 'bursty':
      for (
        let start = 0;
        start < windowMs;
        start += arrival.onMs + arrival.offMs
      )
        poisson(
          arrival.ratePerSec / workers,
          start,
          Math.min(windowMs, start + arrival.onMs),
        );
      break;
    case 'cron':
      for (let start = 0; start < windowMs; start += arrival.everyMs)
        for (let i = 0; i < arrival.perWorker; i++) {
          const t = start + rnd() * arrival.spreadMs;
          if (t < windowMs) push(t);
        }
      break;
    case 'ramp': {
      // Thinning of a Poisson process at the maximum rate.
      const max = Math.max(arrival.fromPerSec, arrival.toPerSec) / workers;
      const mean = 1000 / max;
      for (
        let t = exponential(rnd, mean);
        t < windowMs;
        t += exponential(rnd, mean)
      ) {
        const rate =
          (arrival.fromPerSec +
            ((arrival.toPerSec - arrival.fromPerSec) * t) / windowMs) /
          workers;
        if (rnd() < rate / max) push(t);
      }
      break;
    }
    case 'uneven': {
      const heavy = Math.min(workers, Math.max(1, arrival.heavyWorkers));
      const light = workers - heavy;
      const rate =
        worker < heavy
          ? (arrival.ratePerSec * arrival.heavyShare) / heavy
          : light > 0
            ? (arrival.ratePerSec * (1 - arrival.heavyShare)) / light
            : 0;
      poisson(rate);
      break;
    }
  }
  return out.sort((a, b) => a - b);
}

/** Full offered schedule (open-loop and urgent cohorts) of one worker. */
export function offeredSchedule(
  cell: CellSpec,
  seed: number,
  worker: number,
): Arrival[] {
  const w = cell.workload;
  const rnd = mulberry32(deriveSeed(seed, 'arrivals', worker));
  const out: Arrival[] = [];
  const open = new AttrStream(w, seed, worker, Cohort.open);
  for (const at of arrivalTimes(
    w.arrival,
    cell.workers,
    worker,
    cell.timing.windowMs,
    rnd,
    Math.floor(250000 / cell.workers),
  ))
    out.push({ at, cohort: Cohort.open, ...open.next() });
  if (w.deadlines?.urgent) {
    const u = w.deadlines.urgent;
    const urgent = new AttrStream(w, seed, worker, Cohort.urgent);
    const urnd = mulberry32(deriveSeed(seed, 'urgent', worker));
    for (const at of arrivalTimes(
      { kind: 'poisson', ratePerSec: u.ratePerSec },
      cell.workers,
      worker,
      cell.timing.windowMs,
      urnd,
      Math.floor(250000 / cell.workers) - out.length,
    ))
      out.push({
        at,
        cohort: Cohort.urgent,
        ...urgent.next(),
        maxWaitMs: u.maxWaitMs,
        priority: u.priority,
      });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Fleet-wide offered schedule (all workers), used by the ideal-supply bound. */
export function fleetSchedule(
  cell: CellSpec,
  seed: number,
): (Arrival & { worker: number })[] {
  const all: (Arrival & { worker: number })[] = [];
  for (let w = 0; w < cell.workers; w++)
    for (const a of offeredSchedule(cell, seed, w))
      all.push({ ...a, worker: w });
  return all.sort((a, b) => a.at - b.at || a.worker - b.worker);
}

/** Whether demand is exogenous (open loop or saturated backlog) so an ideal bound is meaningful. */
export function demandIsExogenous(cell: CellSpec): boolean {
  return cell.workload.arrival.kind !== 'clients';
}
