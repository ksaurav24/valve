// Shared planning and execution for real-time tiers. Dry runs never build or start servers.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DEFAULT_POLICY, SYLVIE_POLICY } from '../supervisor/resources.ts';
import { captureFingerprint, fingerprintId } from '../core/fingerprint.ts';
import {
  cellHash,
  planHash,
  runDir,
  type RunManifest,
} from '../core/manifest.ts';
import type { ArmSpec, CellSpec, DecisionPlan } from '../core/types.ts';
import { currentBuild, harnessSha256, refBuild } from '../identity/build.ts';
import { CATALOG, imageId, readInfra, serverUrl } from '../infra/servers.ts';
import {
  estimate,
  fmtDuration,
  loadCalibration,
  trialSeconds,
} from '../plan/budget.ts';
import { LIB_CATEGORIES, libraryMetricsFor, libsCells } from '../plan/libs.ts';
import { aggregateLibraries } from '../analyze/libs.ts';
import {
  metricsFor,
  PROFILES,
  profileCells,
  truncateToBudget,
  type ProfileName,
} from '../plan/profiles.ts';
import { suite } from '../plan/suites.ts';
import { writeReports } from '../report/index.ts';
import { decideIsolation } from '../supervisor/isolate.ts';
import { executeRun, type PlannedTrial } from '../supervisor/runner.ts';

export interface TierOptions {
  tier: 'smoke' | 'matrix' | 'libs' | 'soak' | 'chaos';
  profile?: ProfileName | undefined;
  suites?: string[] | undefined;
  stores?: string[] | undefined;
  categories?: string[] | undefined;
  faults?: string[] | undefined;
  base?: string | undefined;
  head?: string | undefined;
  current?: boolean | undefined;
  rebuild?: boolean | undefined;
  patch?: string | undefined;
  reps?: number | undefined;
  seed?: number | undefined;
  windowMs?: number | undefined;
  warmupMs?: number | undefined;
  drainMs?: number | undefined;
  workers?: number | undefined;
  rate?: number | undefined;
  limitCells?: number | undefined;
  cell?: string | undefined;
  budgetSec?: number | undefined;
  dryRun?: boolean | undefined;
  yes?: boolean | undefined;
  isolate?: boolean | undefined;
  requireAuthoritative?: boolean | undefined;
  workerCpus?: string | undefined;
  endpoint?: string | undefined;
  runId?: string | undefined;
  html?: boolean | undefined;
  keepRaw?: boolean | undefined;
  command?: string[] | undefined;
}

export interface TierPlan {
  cells: CellSpec[];
  skipped: { what: string; reason: string }[];
  looks: number[];
  profile: string;
  audit: boolean;
  armNames: string[];
  estimateSec: number;
  decision: DecisionPlan;
}

/** Explicit short windows scale fault times so sample runs still exercise the requested fault. */
export function overrideCell(cell: CellSpec, opts: TierOptions): CellSpec {
  const windowMs = opts.windowMs ?? cell.timing.windowMs;
  const ratio = windowMs / cell.timing.windowMs;
  const faults = cell.faults?.map((f) => ({
    ...f,
    atMs: Math.min(windowMs - 1, f.atMs * ratio),
    ...('ms' in f
      ? { ms: Math.min(f.ms, Math.max(1, windowMs - f.atMs * ratio - 1)) }
      : {}),
    ...('forMs' in f
      ? { forMs: Math.min(f.forMs, Math.max(1, windowMs - f.atMs * ratio - 1)) }
      : {}),
  }));
  const workers = opts.workers ?? cell.workers;
  if (
    faults?.some(
      (f) => f.type === 'kill-workers' && f.workers.some((w) => w >= workers),
    )
  )
    throw new Error(
      `--workers ${workers} excludes a fault target in ${cell.id}; select another cell`,
    );
  return {
    ...cell,
    workers,
    timing: {
      windowMs,
      warmupMs: opts.warmupMs ?? cell.timing.warmupMs,
      drainMs: opts.drainMs ?? cell.timing.drainMs,
    },
    ...(faults ? { faults } : {}),
    ...(opts.windowMs !== undefined
      ? {
          notes: [
            ...(cell.notes ?? []),
            'Explicit window override: sample only; minimum eligibility-slot requirement may not hold.',
          ],
        }
      : {}),
  };
}

/** Select available workload cells and preregister replications, decision metrics, and execution estimates. */
export function preparePlan(opts: TierOptions): TierPlan {
  const profile =
    opts.profile ?? (opts.tier === 'smoke' ? 'smoke' : 'targeted');
  const def = PROFILES[profile];
  if (profile === 'sylvie') {
    opts = { ...opts, isolate: true };
    if (opts.tier !== 'matrix') throw new Error('sylvie is a matrix profile');
    if (opts.workers !== undefined && opts.workers > 2)
      throw new Error(
        'sylvie supports at most two workers; use targeted for larger fleets',
      );
  }
  const registered = new Set(Object.keys(readInfra().servers));
  const known = new Set([
    ...Object.keys(CATALOG),
    ...Object.keys(CATALOG).map((x) => `${x}-netem`),
    ...registered,
  ]);
  const server = opts.stores?.find((s) => s !== 'memory') ?? 'redis74';
  let cells: CellSpec[];
  const skipped: TierPlan['skipped'] = [];
  if (opts.tier === 'libs') {
    for (const category of opts.categories ?? [])
      if (
        !LIB_CATEGORIES.some(
          (c) => c.id === category || c.base.category === category,
        )
      )
        throw new Error(`unknown library category ${category}`);
    const plan = libsCells('matrix', opts.categories, server);
    cells = plan.cells;
    skipped.push(
      ...plan.na.map((x) => ({
        what: `${x.category}/${x.library}`,
        reason: `N/A: ${x.reason}`,
      })),
    );
  } else if (opts.tier === 'soak') {
    // One continuous stateful trial per selected suite. Low offered load keeps raw data bounded.
    cells = (opts.suites ?? ['lease']).map((s) => {
      const c = suite(s).risk(server)[0];
      if (!c) throw new Error(`suite ${s} has no soak cell`);
      const workers = opts.workers ?? 1;
      return {
        ...c,
        id: `soak/${c.id}`,
        workers,
        faults: [],
        timing: { ...c.timing, windowMs: opts.windowMs ?? 3600000 },
        workload: {
          ...c.workload,
          arrival: {
            kind: 'poisson' as const,
            ratePerSec: opts.rate ?? 2,
          },
          runtime: { ...c.workload.runtime, sampleEveryMs: 1000 },
        },
        notes: [
          ...(c.notes ?? []),
          'Continuous low-load soak; default total offered rate 2 jobs/s. Measures drift/leaks, not saturation performance. Recording limits fail closed.',
        ],
      };
    });
  } else if (opts.tier === 'chaos') {
    cells = (opts.suites ?? ['faults']).flatMap((s) => suite(s).risk(server));
    if (opts.faults?.length) {
      const types = new Set<string>(
        cells.flatMap((c) => c.faults?.map((f) => f.type) ?? []),
      );
      for (const f of opts.faults)
        if (!types.has(f))
          throw new Error(
            `unknown or unavailable fault ${f}; choose ${[...types].join(', ')}`,
          );
      cells = cells.filter((c) =>
        c.faults?.some((f) => opts.faults!.includes(f.type)),
      );
    }
  } else {
    const availability =
      profile === 'sylvie' || opts.dryRun || opts.endpoint ? known : registered;
    const plan = profileCells(profile, opts.suites, availability, {
      store: server,
      valkey:
        server !== 'valkey8' &&
        (!opts.stores || opts.stores.includes('valkey8')),
    });
    cells = plan.cells;
    skipped.push(...plan.skipped);
  }
  cells = cells.filter((c) => {
    const wanted =
      !opts.stores ||
      opts.stores.includes(
        c.store.kind === 'memory' ? 'memory' : c.store.server,
      );
    if (!wanted) skipped.push({ what: c.id, reason: 'excluded by --stores' });
    return wanted;
  });
  if (opts.cell) cells = cells.filter((c) => c.id.includes(opts.cell!));
  cells = cells.map((c) => overrideCell(c, opts));
  cells.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  if (opts.limitCells !== undefined) {
    skipped.push(
      ...cells
        .slice(opts.limitCells)
        .map((c) => ({ what: c.id, reason: 'excluded by --limit-cells' })),
    );
    cells = cells.slice(0, opts.limitCells);
  }
  const single = ['smoke', 'soak', 'chaos', 'libs'].includes(opts.tier);
  const looks =
    opts.reps !== undefined
      ? [opts.reps]
      : single
        ? [opts.tier === 'libs' ? 5 : 1]
        : def.looks;
  const armNames =
    opts.tier === 'libs'
      ? ['base', 'aa']
      : single
        ? ['base']
        : ['base', 'aa', 'head'];
  const libraryAudit = (cell: CellSpec) =>
    cell.library === 'valve' && cell.store.kind === 'redis';
  const audit =
    (!single && def.audit) ||
    (opts.tier === 'libs' && cells.some(libraryAudit));
  const count = looks.at(-1)! * armNames.length + (audit ? 1 : 0);
  const countFor = (cell: CellSpec) =>
    opts.tier === 'libs'
      ? looks.at(-1)! * (cell.library === 'valve' ? 2 : 1) +
        (libraryAudit(cell) ? 1 : 0)
      : count;
  const cal = loadCalibration();
  const budget =
    opts.budgetSec ?? (opts.tier === 'matrix' ? def.budgetSec : null);
  if (budget !== null) {
    // Reserve the same setup/report cost used by estimate().
    const cut = truncateToBudget(
      cells.map((cell) => ({
        cell,
        seconds:
          trialSeconds(cell, cal, !!opts.isolate) *
            countFor(cell) *
            (opts.isolate ? 1 + cal.rejectRate : 1) +
          (opts.isolate
            ? countFor(cell) * cal.rejectRate * cal.cooldownSec
            : 0),
      })),
      Math.max(0, budget - 5),
    );
    cells = cut.kept.map((x) => x.cell);
    skipped.push(
      ...cut.dropped.map((x) => ({
        what: x.cell.id,
        reason: `excluded by ${fmtDuration(budget)} budget`,
      })),
    );
  }
  const trials = cells.flatMap((cell) =>
    Array.from({ length: countFor(cell) }, () => ({ cell })),
  );
  const metrics = [
    ...new Map(
      cells
        .flatMap(opts.tier === 'libs' ? libraryMetricsFor : metricsFor)
        .map((m) => [m.metric, m]),
    ).values(),
  ];
  return {
    cells,
    skipped,
    looks,
    profile: single ? opts.tier : profile,
    armNames,
    audit,
    estimateSec: estimate(trials, cal, !!opts.isolate).withRetriesSeconds,
    decision: { metrics, looks, alpha: def.alpha },
  };
}

/** Print selected cells and explicit exclusion reasons before execution. */
export function printPlan(plan: TierPlan, log: (line: string) => void): void {
  log(
    `${plan.profile}: ${plan.cells.length} cells; arms ${plan.armNames.join('/')}${plan.audit ? ' + audit' : ''}; looks ${plan.looks.join('/')}; estimate ${fmtDuration(plan.estimateSec)}`,
  );
  for (const c of plan.cells)
    log(
      `  ${c.id}: ${c.workers} workers, ${c.timing.windowMs} ms window, ${c.store.kind === 'memory' ? 'memory' : c.store.server}`,
    );
  for (const s of plan.skipped) log(`  skipped ${s.what}: ${s.reason}`);
}

/** Validate authority, freeze builds, execute the immutable plan, and report safety and inference separately. */
export async function runTier(
  opts: TierOptions,
  log: (line: string) => void = console.log,
): Promise<number> {
  if (opts.profile === 'sylvie')
    opts = { ...opts, isolate: true, requireAuthoritative: true };
  const resourcePolicy =
    opts.profile === 'sylvie' ? SYLVIE_POLICY : DEFAULT_POLICY;
  const plan = preparePlan(opts);
  printPlan(plan, log);
  if (!plan.cells.length)
    throw new Error('No cells selected; adjust filters or budget');
  if (opts.dryRun) return 0;
  if (plan.estimateSec > 3600 && !opts.yes)
    throw new Error(
      'Estimate exceeds 60 minutes; inspect --dry-run and pass --yes to execute',
    );
  const servers = [
    ...new Set(
      plan.cells.flatMap((c) =>
        c.store.kind === 'redis' ? [c.store.server] : [],
      ),
    ),
  ];
  const infra = readInfra().servers;
  for (const name of servers)
    if (!infra[name] && !opts.endpoint)
      throw new Error(
        `server ${name} not set up; run pnpm perf infra up ${name}`,
      );
  if (opts.tier === 'matrix' && !opts.base)
    throw new Error('matrix requires --base <ref|current>');
  const images = Object.fromEntries(
    servers.filter((n) => infra[n]).map((n) => [n, imageId(infra[n]!)]),
  );
  const fp = captureFingerprint(images);
  const isolation = decideIsolation(
    fp,
    servers,
    !!opts.isolate,
    opts.workerCpus,
    resourcePolicy,
  );
  if (opts.endpoint) {
    isolation.authoritative = false;
    isolation.reasons.push('explicit endpoint override');
  }
  if (opts.requireAuthoritative && !isolation.authoritative)
    throw new Error(
      `Authoritative execution required: ${isolation.reasons.join('; ')}`,
    );
  const build = (ref?: string) =>
    !ref || ref === 'current'
      ? currentBuild({ rebuild: opts.rebuild ?? true })
      : refBuild(ref);
  const base = build(opts.base);
  const head = plan.armNames.includes('head')
    ? opts.patch
      ? refBuild(
          opts.head ?? (opts.base === 'current' ? 'HEAD' : opts.base) ?? 'HEAD',
          { patch: opts.patch },
        )
      : build(opts.head)
    : undefined;
  const arms: ArmSpec[] = plan.armNames.map((name) => ({
    name,
    build: name === 'head' ? head! : base,
    instrument:
      opts.tier === 'smoke' || opts.tier === 'chaos' ? 'correctness' : 'none',
  }));
  const audits: ArmSpec[] = plan.audit
    ? [{ name: 'audit', build: head ?? base, instrument: 'correctness' }]
    : [];
  const runId =
    opts.runId ??
    `${opts.tier}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const runtime = {
    workerCpus: isolation.workerCpus ?? null,
    serverCpus: isolation.serverCpus ?? {},
    resourcePolicy,
    recordBudgetBytesPerStream: 64 * 1024 ** 2,
  };
  const manifest: RunManifest & { runtime: typeof runtime } = {
    runtime,
    version: 1,
    runId,
    tier: opts.tier,
    profile: plan.profile,
    createdAt: new Date().toISOString(),
    command: opts.command ?? [],
    harnessSha256: harnessSha256(),
    fingerprintId: fingerprintId(fp),
    fingerprint: fp,
    authoritative: isolation.authoritative,
    authoritativeReasons: isolation.reasons,
    builds: { base, ...(head ? { head } : {}) },
    arms: [...arms, ...audits].map((a) => ({
      name: a.name,
      build:
        a.name === 'head' || (a.name === 'audit' && head) ? 'head' : 'base',
      instrument: a.instrument,
    })),
    cells: plan.cells.map((spec) => ({ spec, hash: cellHash(spec) })),
    reps: plan.looks.at(-1)!,
    baseSeed: opts.seed ?? 42,
    decision: plan.decision,
    planHash: '',
    estimateSec: plan.estimateSec,
    servers: Object.fromEntries(
      servers.map((n) => [
        n,
        {
          image: images[n] ?? 'external',
          url: opts.endpoint ?? serverUrl(infra[n]!),
          disposable: !opts.endpoint,
        },
      ]),
    ),
  };
  manifest.planHash = planHash(manifest);
  log(
    `run ${runId}: ${isolation.authoritative ? 'authoritative' : `non-authoritative (${isolation.reasons.join('; ')})`}`,
  );
  const result = await executeRun({
    manifest,
    arms,
    auditArms: audits,
    looks: plan.looks,
    decision: plan.decision,
    metricsFor,
    trial: {
      authoritative: isolation.authoritative,
      policy: runtime.resourcePolicy,
      ...(isolation.workerCpus ? { workerCpus: isolation.workerCpus } : {}),
      ...(opts.endpoint ? { endpointFor: () => opts.endpoint! } : {}),
      keepRaw: opts.keepRaw ?? false,
      log,
    },
    base: 'base',
    candidates: head ? ['head'] : [],
    ...(head ? { aa: 'aa' } : {}),
    ...(opts.tier === 'libs'
      ? {
          includeTrial: (trial: PlannedTrial) =>
            trial.arm.name === 'audit'
              ? trial.cell.library === 'valve' &&
                trial.cell.store.kind === 'redis'
              : trial.arm.name === 'base' || trial.cell.library === 'valve',
        }
      : {}),
    log,
  });
  const executionSummary = result.summary;
  if (opts.tier === 'libs')
    result.summary = aggregateLibraries(
      result.rows,
      plan.cells,
      plan.decision,
      result.summary,
    );
  result.summary.notExecuted.push(...plan.skipped);
  await writeReports(result.summary, runDir(runId), {
    html: opts.html ?? false,
  });
  log(
    `safety=${result.summary.safety}; reports: ${join(runDir(runId), 'report.md')}`,
  );
  if (
    result.stopped ||
    result.summary.safety === 'FAIL' ||
    result.rows.some(
      (r) =>
        r.status === 'failed' ||
        r.status === 'aborted' ||
        (r.status === 'resource-invalid' &&
          !result.rows.some(
            (ok) =>
              ok.cellHash === r.cellHash &&
              ok.arm === r.arm &&
              ok.rep === r.rep &&
              ok.status === 'ok',
          )),
    )
  )
    return 1;
  // Missing or exhausted resource-invalid trials cannot count as a successful run.
  if (
    !result.rows.some((r) => r.status === 'ok') ||
    executionSummary.cells.some((c) =>
      c.arms.some(
        (a) =>
          !result.rows.some(
            (r) => r.cellId === c.cellId && r.arm === a && r.status === 'ok',
          ),
      ),
    )
  )
    return 1;
  return result.summary.cells.some((c) =>
    c.comparisons.some((x) => x.verdict === 'REGRESSION'),
  )
    ? 1
    : 0;
}
