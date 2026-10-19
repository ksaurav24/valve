// One trial: fresh store state, pinned worker processes released at a shared epoch, server and
// worker faults on schedule, then collection, oracles and metrics. Raw records are kept as a
// gzip payload next to the trial row.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Redis } from 'ioredis';
import { decode, decodeLines, encode } from '../core/codec.ts';
import { fileSha256 } from '../core/hash.ts';
import { ensureDir, perfDir, workerEntry } from '../core/paths.ts';
import type {
  ArmSpec,
  CallRecord,
  CellSpec,
  JobRecord,
  ServerEvent,
  TrialRecord,
  WorkerSummary,
} from '../core/types.ts';
import { analyzeTrial } from '../analyze/trial.ts';
import { harnessSha256 } from '../identity/build.ts';
import { decodeLog } from '../lua/log.ts';
import { FaultRunner } from '../infra/faults.ts';
import { infoDelta, infoSnapshot, type InfoSnapshot } from '../infra/info.ts';
import { applyNetwork, clearNetwork, describeNetwork } from '../infra/netem.ts';
import {
  cleanupPrefix,
  endpointLockPath,
  flushDisposable,
  resolveEndpoint,
  type Endpoint,
} from '../infra/safety.ts';
import type { WorkerConfig } from '../driver/worker.ts';
import { acquireEndpointLock } from '../infra/lock.ts';
import {
  awaitHeadroom,
  containerScopes,
  DEFAULT_POLICY,
  ResourceMonitor,
  type ResourcePolicy,
  type ResourceSummary,
} from './resources.ts';

export interface TrialSpec {
  runId: string;
  cell: CellSpec;
  cellHash: string;
  arm: ArmSpec;
  rep: number;
  seed: number;
  attempt: number;
  fingerprintId: string;
}

export interface TrialContext {
  runDir: string;
  authoritative: boolean;
  harnessSha256?: string;
  policy?: ResourcePolicy;
  /** CPU list for worker processes (taskset), e.g. "0-5,8-11". */
  workerCpus?: string;
  /** Explicit Redis endpoint override (infra name or URL). */
  endpointFor?: (cell: CellSpec) => string;
  /** Keep raw ndjson after packing (debugging). */
  keepRaw?: boolean;
  log?: (line: string) => void;
}

interface Handle {
  worker: number;
  proc: ChildProcess;
  ready: Promise<void>;
  exited: Promise<number | null>;
  killed: boolean;
  stderr: string;
}

const now = () => performance.timeOrigin + performance.now();

function launch(
  cfgPath: string,
  worker: number,
  cpus: string | undefined,
): Handle {
  const nodeArgs = ['--import', 'tsx', workerEntry, cfgPath];
  const proc = cpus
    ? spawn('taskset', ['-c', cpus, process.execPath, ...nodeArgs], {
        cwd: perfDir,
        stdio: ['ignore', 'inherit', 'pipe', 'ipc'],
      })
    : spawn(process.execPath, nodeArgs, {
        cwd: perfDir,
        stdio: ['ignore', 'inherit', 'pipe', 'ipc'],
      });
  const h: Handle = {
    worker,
    proc,
    killed: false,
    stderr: '',
    ready: Promise.resolve(),
    exited: Promise.resolve(null),
  };
  proc.stderr?.on(
    'data',
    (d: Buffer) => (h.stderr = (h.stderr + d.toString()).slice(-4000)),
  );
  h.ready = new Promise<void>((resolve, reject) => {
    proc.once('error', reject);
    proc.on(
      'message',
      (m: { type?: string }) => m?.type === 'ready' && resolve(),
    );
    proc.once('exit', (code) =>
      reject(
        new Error(
          `worker ${worker} exited ${code} before ready: ${h.stderr.slice(-1500)}`,
        ),
      ),
    );
  });
  h.exited = new Promise((resolve) => {
    proc.once('exit', (code) => resolve(code));
    proc.once('error', () => resolve(null));
  });
  h.ready.catch(() => undefined);
  return h;
}

export function needsRedis(cell: CellSpec): boolean {
  return cell.store.kind === 'redis' || cell.category?.startsWith('D') === true;
}

/** Execute one trial and return its record. Never throws for trial-level failures. */
export async function runTrial(
  spec: TrialSpec,
  ctx: TrialContext,
): Promise<TrialRecord> {
  const { cell, arm } = spec;
  const policy = ctx.policy ?? DEFAULT_POLICY;
  const trialId = `${spec.cellHash.slice(0, 6)}-${arm.name}-r${spec.rep}-a${spec.attempt}-${randomBytes(2).toString('hex')}`;
  const dir = ensureDir(join(ctx.runDir, 'trials', trialId));
  const started = now();
  const log = ctx.log ?? (() => undefined);
  const record = (partial: Partial<TrialRecord>): TrialRecord => ({
    runId: spec.runId,
    trialId,
    cellId: cell.id,
    cellHash: spec.cellHash,
    arm: arm.name,
    rep: spec.rep,
    seed: spec.seed,
    attempt: spec.attempt,
    fingerprintId: spec.fingerprintId,
    buildDistSha256: arm.build.distSha256,
    startedAt: new Date(started).toISOString(),
    durationSec: (now() - started) / 1000,
    status: 'ok',
    metrics: {},
    outcomes: {},
    safety: {
      status: 'UNVERIFIED',
      checked: [],
      unverified: [],
      counts: {},
      samples: [],
    },
    resources: { valid: false, authoritative: ctx.authoritative, reasons: [] },
    ...partial,
  });

  // Preflight: quiet host before authoritative trials.
  if (ctx.authoritative) {
    const pre = await awaitHeadroom(policy);
    if (!pre.quiet)
      return record({
        status: 'resource-invalid',
        error: 'host never became quiet',
        resources: {
          valid: false,
          authoritative: true,
          reasons: ['preflight-not-quiet'],
        },
      });
  }

  const redis = needsRedis(cell);
  const serverName =
    cell.store.kind === 'redis' ? cell.store.server : 'redis74';
  let endpoint: Endpoint | undefined;
  const keyPrefix = `vp:${trialId}`;
  const quotaId = `q-${trialId}`;
  const luaLogKey =
    arm.instrument === 'correctness' && cell.library === 'valve' && redis
      ? `${keyPrefix}:lualog`
      : undefined;
  let admin: Redis | undefined;
  let faults: FaultRunner | undefined;
  const handles: Handle[] = [];
  let monitor: ResourceMonitor | undefined;
  let resourceAbort: string[] = [];
  const timers = new Set<NodeJS.Timeout>();
  let redisSampler: NodeJS.Timeout | undefined;
  let releaseEndpoint: (() => void) | undefined;
  try {
    if (ctx.harnessSha256 && harnessSha256() !== ctx.harnessSha256)
      throw new Error(
        'Harness changed after manifest creation; start a new run',
      );
    for (const [file, hash] of Object.entries(arm.build.files)) {
      if (fileSha256(join(arm.build.packageDir, file)) !== hash)
        throw new Error(
          `Build artifact changed after manifest creation: ${file}`,
        );
    }
    endpoint = redis
      ? resolveEndpoint(ctx.endpointFor?.(cell) ?? serverName)
      : undefined;
    if (endpoint) {
      // Serialize use of this endpoint across local invocations before any flush or fault.
      const lock = endpointLockPath(endpoint.url);
      releaseEndpoint = acquireEndpointLock(lock, {
        runId: spec.runId,
        trialId,
      });
      admin = new Redis(endpoint.url, { maxRetriesPerRequest: 3 });
      // Fresh store per trial: flush only verified disposable endpoints; otherwise prefix isolation.
      if (endpoint.disposable) await flushDisposable(admin, endpoint);
      if (cell.network) applyNetwork(endpoint, cell.network);
      else if (endpoint.server?.netem) clearNetwork(endpoint);
    }
    // Worker configs.
    const killFaults = (cell.faults ?? []).filter(
      (f) => f.type === 'kill-workers',
    );
    const spawnFaults = (cell.faults ?? []).filter(
      (f) => f.type === 'spawn-workers',
    );
    const serverFaults = (cell.faults ?? []).filter(
      (f) => !['kill-workers', 'spawn-workers'].includes(f.type),
    );
    const baseConfig = (worker: number): WorkerConfig => ({
      cell,
      arm: arm.name,
      worker,
      rep: spec.rep,
      seed: spec.seed,
      quotaId,
      keyPrefix,
      ...(endpoint ? { redisUrl: endpoint.url } : {}),
      valvePackageDir: arm.build.packageDir,
      ...(luaLogKey ? { luaLogKey } : {}),
      recordDir: dir,
    });
    for (let w = 0; w < cell.workers; w++) {
      const path = join(dir, `worker-${w}.json`);
      writeFileSync(path, encode(baseConfig(w)));
      handles.push(launch(path, w, ctx.workerCpus));
    }
    let readyTimer: NodeJS.Timeout | undefined;
    try {
      const readyTimeout = new Promise<never>((_, reject) => {
        readyTimer = setTimeout(
          () => reject(new Error('workers not ready within 60s')),
          60000 + cell.timing.warmupMs,
        );
      });
      await Promise.race([
        Promise.all(handles.map((h) => h.ready)),
        readyTimeout,
      ]);
    } finally {
      clearTimeout(readyTimer);
    }

    // Shared epoch; instruments at the window edges.
    const epochAt = now() + 300 + cell.workers * 5;
    const ids = endpoint
      ? endpoint.server?.container
        ? serverContainerIds(endpoint)
        : null
      : [];
    const scopes = ids === null ? null : containerScopes(ids);
    monitor = new ResourceMonitor(
      policy,
      ctx.authoritative,
      scopes,
      (reasons) => {
        resourceAbort = reasons;
        for (const h of handles) h.proc.kill('SIGKILL');
      },
    );
    if (admin && endpoint) {
      faults = new FaultRunner(
        endpoint,
        admin,
        epochAt,
        keyPrefix,
        luaLogKey ? { logKey: luaLogKey, dir } : undefined,
      );
      await faults.prepare(serverFaults);
    }
    let infoA: InfoSnapshot | undefined;
    let infoB: InfoSnapshot | undefined;
    const at = (ms: number, fn: () => void) =>
      timers.add(setTimeout(fn, Math.max(0, epochAt + ms - now())));
    at(0, () => {
      monitor?.edge('start');
      if (admin)
        void infoSnapshot(admin).then(
          (s) => (infoA = s),
          () => undefined,
        );
    });
    at(cell.timing.windowMs, () => {
      monitor?.edge('end');
      if (admin)
        void infoSnapshot(admin).then(
          (s) => (infoB = s),
          () => undefined,
        );
    });
    const killed = new Set<number>();
    const resets: number[] = [];
    for (const f of serverFaults)
      at(f.atMs, () => {
        if (f.type === 'redis-restart') resets.push(now());
        void faults!.fire(f).then(() => {
          if (f.type === 'redis-restart') resets[resets.length - 1] = now();
        });
      });
    for (const f of killFaults)
      at(f.atMs, () => {
        for (const w of f.workers) {
          const h = handles[w];
          if (h) {
            h.killed = true;
            killed.add(w);
            h.proc.kill('SIGKILL');
          }
        }
        faults?.log.push({
          type: 'kill-workers',
          plannedAtMs: f.atMs,
          firedAtMs: now() - epochAt,
          detail: { workers: f.workers },
        });
      });
    let nextWorker = cell.workers;
    for (const f of spawnFaults)
      at(f.atMs, () => {
        for (let i = 0; i < f.count; i++) {
          const w = nextWorker++;
          const cfg: WorkerConfig = {
            ...baseConfig(w),
            cold: { epochAt },
            startDelayMs: f.atMs,
          };
          const path = join(dir, `worker-${w}.json`);
          writeFileSync(path, encode(cfg));
          handles.push(launch(path, w, ctx.workerCpus));
        }
        faults?.log.push({
          type: 'spawn-workers',
          plannedAtMs: f.atMs,
          firedAtMs: now() - epochAt,
          detail: { count: f.count },
        });
      });
    for (const h of handles) h.proc.send({ type: 'go', epochAt });
    // Soak: sample server memory and key count alongside worker samples.
    const redisSamples: { t: number; usedMemory: number; keys: number }[] = [];
    const sampleEvery = cell.workload.runtime?.sampleEveryMs;
    redisSampler =
      sampleEvery && admin
        ? setInterval(() => {
            void Promise.all([admin!.info('memory'), admin!.dbsize()]).then(
              ([info, keys]) =>
                redisSamples.push({
                  t: now(),
                  usedMemory: Number(/used_memory:(\d+)/.exec(info)?.[1] ?? 0),
                  keys,
                }),
              () => undefined,
            );
          }, sampleEvery)
        : undefined;

    // Watchdog: everything must finish within window + drain + generous slack.
    const limitMs = cell.timing.windowMs + cell.timing.drainMs + 30000;
    const watchdog = setTimeout(
      () => {
        log(`trial ${trialId}: watchdog kill after ${limitMs}ms`);
        for (const h of handles) h.proc.kill('SIGKILL');
      },
      epochAt - now() + limitMs,
    );
    timers.add(watchdog);
    // Late joins must have been spawned before waiting for every worker to exit.
    if (spawnFaults.length) {
      const last = Math.max(...spawnFaults.map((f) => f.atMs));
      await new Promise((r) =>
        setTimeout(r, Math.max(0, epochAt + last - now() + 50)),
      );
    }
    await Promise.all(handles.map((h) => h.exited));
    clearTimeout(watchdog);
    if (redisSampler) clearInterval(redisSampler);
    for (const t of timers) clearTimeout(t);
    await faults?.stopAll();
    const resources = monitor.finish();
    monitor = undefined;

    // Collect.
    const jobs: JobRecord[] = [];
    const calls: CallRecord[] = [];
    const summaries: WorkerSummary[] = [];
    const samples: { w: number; t: number; heap: number; rss: number }[] = [];
    for (const h of handles) {
      const pf = join(dir, `samples-${h.worker}.ndjson`);
      if (existsSync(pf))
        for (const row of decodeLines<{
          w: number;
          t: number;
          heap: number;
          rss: number;
        }>(readFileSync(pf, 'utf8')))
          samples.push(row);
      const jf = join(dir, `jobs-${h.worker}.ndjson`);
      const cf = join(dir, `calls-${h.worker}.ndjson`);
      const sf = join(dir, `summary-${h.worker}.json`);
      if (existsSync(jf))
        for (const row of decodeLines<JobRecord>(readFileSync(jf, 'utf8')))
          jobs.push(row);
      if (existsSync(cf))
        for (const row of decodeLines<CallRecord>(readFileSync(cf, 'utf8')))
          calls.push(row);
      if (existsSync(sf))
        summaries.push(decode<WorkerSummary>(readFileSync(sf, 'utf8')));
      else
        summaries.push({
          worker: h.worker,
          pid: h.proc.pid ?? -1,
          submitted: 0,
          generatorLagP99Ms: 0,
          generatorLagMaxMs: 0,
          backlogMinDepth: null,
          windowCpuUs: 0,
          eldP50Ms: null,
          eldP99Ms: null,
          eldMaxMs: null,
          maxRssBytes: 0,
          heapUsedBytes: 0,
          totals: {},
          errors: {},
          crashed: true,
          clockDriftMs: 0,
        });
    }
    const unexpected = handles.filter(
      (h) => !h.killed && !existsSync(join(dir, `summary-${h.worker}.json`)),
    );
    if (resourceAbort.length)
      return record({
        status: 'resource-invalid',
        error: `resource guard: ${resourceAbort.join(',')}`,
        resources: resources as unknown as TrialRecord['resources'],
      });
    let events: ServerEvent[] | undefined;
    const restartAudits = faults?.restartAudits ?? [];
    const restartAuditComplete =
      !!luaLogKey &&
      restartAudits.length === resets.length &&
      restartAudits.every((audit) => audit.complete);
    if (luaLogKey && admin) {
      const prior = restartAudits.flatMap((audit) =>
        decode<string[]>(readFileSync(audit.file, 'utf8')),
      );
      events = decodeLog([...prior, ...(await admin.lrange(luaLogKey, 0, -1))]);
    }
    const info = infoA && infoB ? infoDelta(infoA, infoB) : undefined;
    const analysis = analyzeTrial({
      cell,
      seed: spec.seed,
      epochAt,
      quotaId,
      jobs,
      calls,
      summaries,
      ...(events ? { events } : {}),
      ...(info ? { info } : {}),
      killedWorkers: killed,
      resets: restartAuditComplete
        ? restartAudits.map((audit) => audit.resetAt)
        : resets,
      restartAuditComplete,
      asymmetric: !!cell.faults?.length,
      faultLog: faults?.log ?? [],
      ...(samples.length ? { samples } : {}),
      ...(redisSamples.length ? { redisSamples } : {}),
    });
    if (ctx.harnessSha256 && harnessSha256() !== ctx.harnessSha256)
      throw new Error(
        'Harness changed during trial; evidence is retained but the trial is invalid',
      );
    const payload = 'payload.json.gz';
    writeFileSync(
      join(dir, payload),
      gzipSync(
        encode({
          cell,
          arm: arm.name,
          epochAt,
          quotaId,
          faults: faults?.log ?? [],
          network: endpoint ? describeNetwork(endpoint) : null,
          info: { a: infoA, b: infoB },
          summaries,
          samples,
          redisSamples,
          jobs,
          calls,
          events: events ?? null,
          restartAudits,
          notes: analysis.notes,
        }),
      ),
    );
    if (!ctx.keepRaw)
      for (const f of readdirSync(dir))
        if (f.endsWith('.ndjson') || /^worker-\d+\.json$/.test(f))
          rmSync(join(dir, f));
    const rec = record({
      status:
        unexpected.length || faults?.log.some((entry) => entry.error)
          ? 'failed'
          : resources.valid
            ? 'ok'
            : 'resource-invalid',
      ...(unexpected.length || faults?.log.some((entry) => entry.error)
        ? {
            error: `trial execution failed: ${unexpected.map((h) => `${h.worker}: ${h.stderr.slice(-300)}`).join(' | ')} ${
              faults?.log
                .filter((entry) => entry.error)
                .map((entry) => entry.error)
                .join(' | ') ?? ''
            }`,
          }
        : {}),
      metrics: analysis.metrics,
      notes: analysis.notes,
      outcomes: analysis.outcomes,
      safety: analysis.safety,
      resources: resources as unknown as TrialRecord['resources'],
      payload: join('trials', trialId, payload),
    });
    writeFileSync(join(dir, 'trial.json'), encode(rec, 2));
    return rec;
  } catch (error) {
    for (const h of handles) h.proc.kill('SIGKILL');
    const resources: ResourceSummary | undefined = monitor?.finish();
    return record({
      status: 'failed',
      error: String((error as Error)?.stack ?? error).slice(0, 2000),
      ...(resources
        ? { resources: resources as unknown as TrialRecord['resources'] }
        : {}),
    });
  } finally {
    for (const t of timers) clearTimeout(t);
    if (redisSampler) clearInterval(redisSampler);
    for (const h of handles)
      if (h.proc.exitCode === null && h.proc.signalCode === null)
        h.proc.kill('SIGKILL');
    await faults?.stopAll().catch(() => undefined);
    if (admin && endpoint) {
      try {
        if (!endpoint.disposable) {
          await cleanupPrefix(admin, keyPrefix);
          // Bottleneck clustering keys are named `b_<id>_…`; the id is this trial's quota id.
          if (cell.library === 'bottleneck')
            await cleanupPrefix(admin, `b_${quotaId}`);
        }
        if (cell.network) clearNetwork(endpoint);
      } catch (error) {
        log(`cleanup failed: ${String(error)}`);
      }
      admin.disconnect();
    }
    releaseEndpoint?.();
  }
}

/** Resolve the full server container ID; failed inspection leaves CPU ownership unknown. */
function serverContainerIds(endpoint: Endpoint): string[] | null {
  try {
    return [
      execFileSync(
        'docker',
        ['inspect', '-f', '{{.Id}}', endpoint.server!.container!],
        { encoding: 'utf8' },
      ).trim(),
    ];
  } catch {
    return null;
  }
}
