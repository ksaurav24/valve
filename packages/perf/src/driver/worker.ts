// One worker process. Loads the library under test, warms it on a separate budget, waits for the
// shared epoch, generates the offered workload, and streams job/call records to files.
// IPC carries only control messages and a small summary.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decode, encode } from '../core/codec.ts';
import {
  Cohort,
  Outcome,
  type CellSpec,
  type JobRecord,
  type OutcomeCode,
  type WorkerSummary,
} from '../core/types.ts';
import { deriveSeed, mulberry32, sample } from '../core/rng.ts';
import {
  AttrStream,
  offeredSchedule,
  type JobAttrs,
} from '../workload/schedule.ts';
import { adapterFor } from '../adapters/index.ts';
import type { Limiter } from '../adapters/types.ts';
import { Recorder } from './recorder.ts';
import { epochNow } from '../core/clock.ts';

export interface WorkerConfig {
  cell: CellSpec;
  arm: string;
  worker: number;
  rep: number;
  seed: number;
  quotaId: string;
  keyPrefix: string;
  redisUrl?: string;
  valvePackageDir: string;
  luaLogKey?: string;
  recordDir: string;
  /** Join after the epoch (churn) and stop generating early. */
  startDelayMs?: number;
  stopAtMs?: number;
  /** Cold workers join mid-run without the ready/go barrier. */
  cold?: { epochAt: number };
}

const now = epochNow;
const sleepUntil = (at: number) =>
  new Promise<void>((r) => setTimeout(r, Math.max(0, at - now())));
const spin = (ms: number) => {
  const until = performance.now() + ms;
  while (performance.now() < until);
};

async function main() {
  const cfg = decode<WorkerConfig>(readFileSync(process.argv[2]!, 'utf8'));
  const { cell } = cfg;
  const maxRecordBytes = Math.floor((64 * 1024 ** 2) / cell.workers);
  const jobsOut = new Recorder(
    join(cfg.recordDir, `jobs-${cfg.worker}.ndjson`),
    1 << 16,
    maxRecordBytes,
  );
  const callsOut = new Recorder(
    join(cfg.recordDir, `calls-${cfg.worker}.ndjson`),
    1 << 16,
    maxRecordBytes,
  );
  const errors: Record<string, number> = {};
  const instances = cell.instances ?? 1;
  const adapter = adapterFor(cell.library);
  let lastReply = -1;
  let recordCalls = false;
  const makeCtx = (quotaId: string, instance: number) => ({
    cell,
    worker: cfg.worker,
    instance,
    quotaId,
    keyPrefix: cfg.keyPrefix,
    ...(cfg.redisUrl ? { redisUrl: cfg.redisUrl } : {}),
    valvePackageDir: cfg.valvePackageDir,
    ...(cfg.luaLogKey ? { luaLogKey: cfg.luaLogKey } : {}),
    now,
    onCall: (r: import('../core/types.ts').CallRecord) => {
      if (r.op === 'acquire' || r.op === 'scoped') lastReply = r.t1;
      if (recordCalls) callsOut.write(r);
    },
  });

  // Warmup on a separate quota id: connections, script cache and JIT, outside the measurement.
  if (!cfg.cold && cell.timing.warmupMs > 0) {
    const warm = await adapter.create(
      makeCtx(`${cfg.quotaId}-warm-${cfg.worker}`, 0),
    );
    const until = now() + cell.timing.warmupMs;
    const pending: Promise<unknown>[] = [];
    let i = 0;
    while (now() < until && i < 256) {
      pending.push(
        warm.submit(() => undefined, { cost: 1 }).catch(() => undefined),
      );
      i++;
      if (i % 16 === 0) await new Promise((r) => setImmediate(r));
    }
    // Warmup is a fixed window. Draining a rate-limited queue here can add seconds
    // beyond the declared budget, while early completion would skip warmup entirely.
    await sleepUntil(until);
    await warm.close();
  }
  const limiters: Limiter[] = [];
  for (let k = 0; k < instances; k++)
    limiters.push(await adapter.create(makeCtx(cfg.quotaId, k)));

  let epochAt: number;
  if (cfg.cold) epochAt = cfg.cold.epochAt;
  else {
    process.send!({ type: 'ready' });
    epochAt = await new Promise<number>((resolve) =>
      process.on(
        'message',
        (m: { type: string; epochAt: number }) =>
          m.type === 'go' && resolve(m.epochAt),
      ),
    );
  }
  const windowEnd =
    epochAt + Math.min(cell.timing.windowMs, cfg.stopAtMs ?? Infinity);
  const observationEnd = epochAt + cell.timing.windowMs + cell.timing.drainMs;
  await sleepUntil(epochAt + (cfg.startDelayMs ?? 0));
  recordCalls = true;

  // Window instruments: CPU and event-loop delay (10 ms default; 1 ms perturbs scheduling).
  const resolution = cell.workload.runtime?.eldResolutionMs ?? 10;
  const eld = resolution > 0 ? monitorEventLoopDelay({ resolution }) : null;
  eld?.enable();
  const cpu0 = process.cpuUsage();
  let cpuWindow = 0;
  const cpuTimer = setTimeout(
    () => {
      const c = process.cpuUsage(cpu0);
      cpuWindow = c.user + c.system;
      eld?.disable();
    },
    Math.max(0, windowEnd - now()),
  );
  const runtime = cell.workload.runtime;
  const samplesOut = runtime?.sampleEveryMs
    ? new Recorder(join(cfg.recordDir, `samples-${cfg.worker}.ndjson`))
    : undefined;
  let startedCount = 0;
  const sampler = runtime?.sampleEveryMs
    ? setInterval(() => {
        const m = process.memoryUsage();
        samplesOut!.write({
          w: cfg.worker,
          t: now(),
          heap: m.heapUsed,
          rss: m.rss,
          external: m.external,
          started: startedCount,
          submitted,
          outstanding: outstanding.size,
        });
      }, runtime.sampleEveryMs)
    : undefined;
  const bg = runtime?.bgTimerMs
    ? setInterval(() => spin(runtime.bgWorkMs ?? 0.05), runtime.bgTimerMs)
    : undefined;

  let seq = 0;
  let submitted = 0;
  const lags: number[] = [];
  const outstanding = new Map<number, JobRecord>();
  const promises = new Set<Promise<void>>();
  const abortTimers = new Set<NodeJS.Timeout>();
  let rr = 0;
  let backlogPending = 0;
  let backlogMin = Infinity;
  let generating = true;
  const controlTimers: NodeJS.Timeout[] = [];
  const controlPromises: Promise<void>[] = [];
  for (const control of cell.controls ?? []) {
    if (control.worker !== cfg.worker) continue;
    controlTimers.push(
      setTimeout(
        () => {
          for (const limiter of limiters) {
            if (!limiter.control)
              throw new Error(
                'selected adapter does not support lifecycle controls',
              );
            controlPromises.push(
              limiter.control(control.action, control.durationMs),
            );
          }
        },
        Math.max(0, epochAt + control.atMs - now()),
      ),
    );
  }

  const finish = (rec: JobRecord, o: OutcomeCode, code?: string) => {
    if (rec.o !== Outcome.pending) return;
    rec.o = o;
    if (rec.en < 0) rec.en = now();
    if (code) rec.code = code;
    outstanding.delete(rec.i);
    jobsOut.write(rec);
  };

  function submit(
    attrs: JobAttrs,
    cohort: number,
    intendedAt: number,
    after?: () => void,
  ): Promise<void> {
    const sa = now();
    if (cohort === Cohort.open || cohort === Cohort.urgent)
      lags.push(sa - intendedAt);
    const rec: JobRecord = {
      w: cfg.worker,
      i: seq++,
      k: cohort,
      ia: intendedAt,
      sa,
      st: -1,
      en: -1,
      o: Outcome.pending,
      c: attrs.cost,
      mw: attrs.maxWaitMs ?? -1,
      ab: -1,
      rp: -1,
      sd: Date.now(),
      sdStart: -1,
      ...(attrs.scopes ? { sc: Object.values(attrs.scopes).join('|') } : {}),
    };
    outstanding.set(rec.i, rec);
    submitted++;
    let controller: AbortController | undefined;
    if (attrs.abortAfterMs !== undefined) {
      controller = new AbortController();
      const c = controller;
      const timer = setTimeout(() => {
        abortTimers.delete(timer);
        if (cell.workload.abort?.queuedOnly && rec.st >= 0) return;
        if (rec.st < 0 && rec.o === Outcome.pending) rec.ab = now();
        c.abort();
      }, attrs.abortAfterMs);
      abortTimers.add(timer);
    }
    const limiter = limiters[rr++ % limiters.length]!;
    const p = limiter
      .submit(
        () => {
          rec.st = now();
          rec.sdStart = Date.now();
          startedCount++;
          rec.rp = lastReply;
          try {
            after?.();
            if (attrs.fail) throw new Error('planned failure');
            if (cell.workload.job.kind === 'sync' && attrs.durationMs > 0)
              spin(attrs.durationMs);
            else if (cell.workload.job.kind === 'async' && attrs.durationMs > 0)
              return new Promise<void>((r) =>
                setTimeout(r, attrs.durationMs),
              ).finally(() => {
                rec.en = now();
              });
            rec.en = now();
            return undefined;
          } catch (error) {
            rec.en = now();
            throw error;
          }
        },
        {
          cost: attrs.cost,
          ...(attrs.priority !== undefined ? { priority: attrs.priority } : {}),
          ...(attrs.maxWaitMs !== undefined
            ? { maxWaitMs: attrs.maxWaitMs }
            : {}),
          ...(controller ? { signal: controller.signal } : {}),
          ...(attrs.scopes ? { scopes: attrs.scopes } : {}),
        },
      )
      .then(
        () => {
          finish(rec, Outcome.completed);
        },
        (error: { code?: string; message?: string }) => {
          const code = error?.code;
          if (rec.st >= 0) {
            finish(rec, Outcome.failed, code ?? 'JOB_ERROR');
          } else if (code === 'MAX_WAIT_EXCEEDED')
            finish(rec, Outcome.expired, code);
          else if (
            code === 'ABORTED' ||
            (error as Error)?.name === 'AbortError'
          )
            finish(rec, Outcome.aborted, code ?? 'AbortError');
          else {
            const c = code ?? String(error?.message ?? error).slice(0, 60);
            errors[c] = (errors[c] ?? 0) + 1;
            finish(rec, Outcome.rejected, c);
          }
        },
      );
    promises.add(p);
    void p.then(() => promises.delete(p));
    return p;
  }

  const loops: Promise<void>[] = [];
  const arrival = cell.workload.arrival;
  // Saturated closed loop: maintained depth, refilled on each start until the window ends.
  if (arrival.kind === 'backlog') {
    const attrs = new AttrStream(
      cell.workload,
      cfg.seed,
      cfg.worker,
      Cohort.backlog,
    );
    const add = () => {
      backlogPending++;
      let started = false;
      const leave = () => {
        backlogPending--;
        if (generating && now() < windowEnd) {
          backlogMin = Math.min(backlogMin, backlogPending);
          setImmediate(() => {
            if (generating && now() < windowEnd) add();
          });
        }
      };
      void submit(attrs.next(), Cohort.backlog, now(), () => {
        started = true;
        leave();
      }).then(() => {
        // Jobs that never start (expired, aborted, rejected) also leave the backlog.
        if (!started) leave();
      });
    };
    for (let i = 0; i < arrival.depth; i++) add();
  }
  // Finite closed loop: demand depends on the system (no ideal bound).
  if (arrival.kind === 'clients') {
    const attrs = new AttrStream(
      cell.workload,
      cfg.seed,
      cfg.worker,
      Cohort.client,
    );
    const think = mulberry32(deriveSeed(cfg.seed, 'think', cfg.worker));
    for (let c = 0; c < arrival.clients; c++)
      loops.push(
        (async () => {
          while (generating && now() < windowEnd) {
            await submit(attrs.next(), Cohort.client, now());
            await new Promise((r) =>
              setTimeout(
                r,
                Math.max(
                  0,
                  Math.min(sample(think, arrival.think), windowEnd - now()),
                ),
              ),
            );
          }
        })(),
      );
  }
  // Open loop: precomputed intended arrivals, submitted on time regardless of responses.
  const schedule = offeredSchedule(cell, cfg.seed, cfg.worker).filter(
    (a) => a.at >= (cfg.startDelayMs ?? 0),
  );
  if (schedule.length)
    loops.push(
      (async () => {
        let i = 0;
        while (i < schedule.length && generating) {
          const due = epochAt + schedule[i]!.at;
          if (due >= windowEnd) break;
          const wait = due - now();
          if (wait > 1)
            await new Promise((r) => setTimeout(r, Math.min(wait - 0.5, 50)));
          else {
            while (
              i < schedule.length &&
              epochAt + schedule[i]!.at <= now() &&
              epochAt + schedule[i]!.at < windowEnd
            ) {
              const a = schedule[i++]!;
              void submit(a, a.cohort, epochAt + a.at);
            }
            await new Promise((r) => setImmediate(r));
          }
        }
      })(),
    );

  await sleepUntil(windowEnd);
  generating = false;
  for (const timer of controlTimers) clearTimeout(timer);
  await Promise.all(controlPromises);
  await Promise.all(loops);
  // Drain: follow outstanding jobs to a terminal outcome until observation ends.
  const drained = Promise.all([...promises]);
  await Promise.race([drained, sleepUntil(observationEnd)]);
  clearTimeout(cpuTimer);
  if (!cpuWindow) {
    const c = process.cpuUsage(cpu0);
    cpuWindow = c.user + c.system;
    eld?.disable();
  }
  if (bg) clearInterval(bg);
  if (sampler) clearInterval(sampler);
  for (const timer of abortTimers) clearTimeout(timer);
  await samplesOut?.close();
  // Right-censor everything still queued at observation end (not "infinite" waits).
  const censorAt = now();
  for (const rec of [...outstanding.values()])
    if (rec.st < 0) {
      rec.en = censorAt;
      finish(rec, Outcome.unserved);
    }
  recordCalls = false;
  await Promise.all(limiters.map((l) => l.close()));
  // Some libraries' close() does not wait for running jobs; give started jobs a bounded grace.
  await Promise.race([
    Promise.all(promises),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  // Anything still without a terminal outcome is written as pending; the oracle counts it as lost.
  for (const rec of [...outstanding.values()]) {
    outstanding.delete(rec.i);
    jobsOut.write(rec);
  }
  const usage = process.resourceUsage();
  lags.sort((a, b) => a - b);
  const summary: WorkerSummary = {
    worker: cfg.worker,
    pid: process.pid,
    submitted,
    generatorLagP99Ms: lags.length
      ? lags[Math.min(lags.length - 1, Math.floor(lags.length * 0.99))]!
      : 0,
    generatorLagMaxMs: lags.length ? lags.at(-1)! : 0,
    backlogMinDepth:
      arrival.kind === 'backlog' && Number.isFinite(backlogMin)
        ? backlogMin
        : null,
    windowCpuUs: cpuWindow,
    eldP50Ms: eld ? eld.percentile(50) / 1e6 : null,
    eldP99Ms: eld ? eld.percentile(99) / 1e6 : null,
    eldMaxMs: eld ? eld.max / 1e6 : null,
    maxRssBytes: usage.maxRSS * 1024,
    heapUsedBytes: process.memoryUsage().heapUsed,
    totals: Object.assign({}, ...limiters.map((l) => l.stats?.() ?? {})),
    errors,
    clockDriftMs: Date.now() - now(),
  };
  await jobsOut.close();
  await callsOut.close();
  writeFileSync(
    join(cfg.recordDir, `summary-${cfg.worker}.json`),
    encode(summary),
  );
  if (process.send) process.send({ type: 'done' }, () => process.exit(0));
  else process.exit(0);
}

main().catch((error) => {
  console.error('WORKER_FATAL', error);
  process.exit(70);
});
