#!/usr/bin/env -S node --import tsx
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { decode, encode } from './core/codec.ts';
import { readManifest, runDir } from './core/manifest.ts';
import { perfDir } from './core/paths.ts';
import type { RunSummary } from './analyze/summary.ts';
import { currentBuild, refBuild } from './identity/build.ts';
import { buildNetemImage, hasImage } from './infra/images.ts';
import {
  adopt,
  CATALOG,
  down,
  netemImage,
  readInfra,
  status,
  up,
} from './infra/servers.ts';
import { catalogArchive } from './legacy/catalog.ts';
import { parseDuration } from './plan/budget.ts';
import { PROFILES, type ProfileName } from './plan/profiles.ts';
import { writeReports } from './report/index.ts';
import { reexecIsolated } from './supervisor/isolate.ts';
import { SYLVIE_POLICY } from './supervisor/resources.ts';
import { runSylvie } from './tiers/sylvie.ts';
import { c1, calibrate, doctor, micro, model } from './tiers/local.ts';
import { c1Safety, type C1Result } from './tiers/c1.ts';
import { measure } from './measure/run.ts';
import {
  preparePlan,
  printPlan,
  runTier,
  type TierOptions,
} from './tiers/run.ts';

export const HELP = `Valve performance and correctness harness (private; Node >=24)
Usage: pnpm perf <command> [options]
  doctor | calibrate [--reps 3]
  build [--ref REF] [--patch FILE] [--rebuild]
  infra up|down|status|images [SERVER,...] [--cpuset CPUS] [--recreate]
  infra adopt URL --empty-only [--name NAME]
  micro [--quick] [--filter TEXT] | model | quick
  footprint [--check] [--base REF] | startup [--base REF] [--reps 3]
  scoped [--stores memory,redis74] [--iterations 100] [--base REF]
  drift [--base REF] [--jobs 200] [--response-ms 0] [--reps 3]
  plan --profile smoke|targeted|sylvie|nightly|decision [--suite NAME,...] [--budget 40m]
  smoke | matrix --base REF [--head REF|--current] [--profile targeted]
  libs [--category L1,L2,D1] | soak [--duration 4h] | chaos [--faults TYPE,...]
  c1 [--stores memory,redis74] | report RUN_ID [--html]
  legacy catalog [--archive DIR] | legacy golden
Real-time options:
  --stores memory,redis74,valkey8  --suite NAME,...  --cell TEXT  --limit-cells N
  --window 2s (alias --duration)  --window-ms N  --warmup-ms N  --drain-ms N
  --workers N (1..64)  --reps N  --seed N  --rate N (soak total offered jobs/s)
  --dry-run  --budget 40m  --yes  --isolate  --worker-cpus CPUS
  --require-authoritative (dedicated CI; fail if isolation requirements are unmet)
  --endpoint URL  --run-id ID  --html  --keep-raw
Sylvie: matrix --profile sylvie defaults to HEAD vs current; 2 workers, 10 pairs,
  15s windows, automatic CPU placement, owned store setup/cleanup, 3 GiB scope, no swap.
Dry runs print estimates without builds or trial execution. Estimates >60 min require --yes.
Exit: 0 completed; 1 safety/regression/execution failure; 2 invalid arguments or setup.
C1: 0 verified deadline rejection; 1 late callback; 2 inconclusive verification.`;

const strings = [
  'ref',
  'patch',
  'profile',
  'suite',
  'stores',
  'store',
  'budget',
  'base',
  'head',
  'category',
  'reps',
  'duration',
  'window',
  'window-ms',
  'warmup-ms',
  'drain-ms',
  'workers',
  'seed',
  'rate',
  'limit-cells',
  'cell',
  'faults',
  'worker-cpus',
  'cpuset',
  'endpoint',
  'run-id',
  'name',
  'filter',
  'archive',
  'jobs',
  'response-ms',
  'iterations',
];
const booleans = [
  'help',
  'yes',
  'dry-run',
  'isolate',
  'require-authoritative',
  'current',
  'rebuild',
  'quick',
  'html',
  'keep-raw',
  'empty-only',
  'recreate',
  'build',
  'check',
];
const commonRun = [
  'profile',
  'suite',
  'stores',
  'store',
  'budget',
  'base',
  'head',
  'current',
  'patch',
  'rebuild',
  'category',
  'reps',
  'duration',
  'window',
  'window-ms',
  'warmup-ms',
  'drain-ms',
  'workers',
  'seed',
  'rate',
  'limit-cells',
  'cell',
  'faults',
  'worker-cpus',
  'endpoint',
  'run-id',
  'yes',
  'dry-run',
  'isolate',
  'require-authoritative',
  'html',
  'keep-raw',
];
const allowed: Record<string, string[]> = {
  doctor: [],
  calibrate: ['reps', 'isolate'],
  build: ['ref', 'patch', 'rebuild'],
  infra: ['stores', 'cpuset', 'recreate', 'empty-only', 'name', 'build'],
  micro: ['quick', 'filter', 'rebuild'],
  model: [],
  quick: ['filter', 'rebuild'],
  footprint: ['check', 'base', 'head', 'current'],
  startup: ['base', 'head', 'current', 'reps'],
  scoped: ['base', 'head', 'current', 'reps', 'iterations', 'stores'],
  drift: ['base', 'head', 'current', 'reps', 'jobs', 'response-ms'],
  plan: commonRun,
  smoke: commonRun,
  matrix: commonRun,
  libs: commonRun,
  soak: commonRun,
  chaos: commonRun,
  c1: ['stores', 'store', 'endpoint', 'rebuild'],
  report: ['html'],
  legacy: ['archive'],
};

export class UsageError extends Error {}
const fail = (message: string): never => {
  throw new UsageError(message);
};
const csv = (value: string | undefined) =>
  value === undefined
    ? undefined
    : value
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
/** Validate a bounded numeric CLI value before any build or infrastructure operation. */
function numberOption(
  value: string | undefined,
  name: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
  integer = true,
): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (
    !value.trim() ||
    !Number.isFinite(number) ||
    number < min ||
    number > max ||
    (integer && !Number.isSafeInteger(number))
  )
    fail(
      `--${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`,
    );
  return number;
}
/** Parse a positive CLI duration, bounded to twelve hours. */
function duration(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  let result: number;
  try {
    result = parseDuration(value);
  } catch {
    return fail(`--${name} expects seconds or a duration such as 2s, 40m, 4h`);
  }
  if (!Number.isFinite(result) || result <= 0 || result > 12 * 3600)
    fail(`--${name} must be positive and at most 12h`);
  return result;
}
const safeId = (value: string, name: string) =>
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) && value !== '..'
    ? value
    : fail(`invalid ${name}: ${value}`);
const cpus = (value: string | undefined) => {
  if (value !== undefined && !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(value))
    fail('CPU lists must look like 0-3,6');
  for (const part of value?.split(',') ?? []) {
    const [a, b] = part.split('-').map(Number);
    if (b !== undefined && (b < a! || b - a! > 65536))
      fail('invalid CPU range');
  }
  return value;
};

/** Validate command-specific options and resolve user paths from the invocation directory. */
export function parseCli(argv: string[]) {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: Object.fromEntries([
        ...strings.map((name) => [name, { type: 'string' as const }]),
        ...booleans.map((name) => [name, { type: 'boolean' as const }]),
      ]),
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const v = parsed.values as Record<string, string | boolean | undefined>;
  const text = (key: string) =>
    typeof v[key] === 'string' ? (v[key] as string) : undefined;
  const command = parsed.positionals[0] ?? 'help';
  const args = parsed.positionals.slice(1);
  if (v.help || command === 'help')
    return { command: 'help', args: [], values: v, options: undefined };
  if (!allowed[command]) fail(`unknown command ${command}; use --help`);
  for (const key of Object.keys(v))
    if (!allowed[command]!.includes(key))
      fail(`--${key} is not supported by ${command}`);
  if (!['infra', 'report', 'legacy'].includes(command) && args.length)
    fail(`unexpected positional argument: ${args[0]}`);
  if (v.head && v.current) fail('--head and --current are mutually exclusive');
  if (v.stores && v.store) fail('use only one of --stores and --store');
  for (const key of ['suite', 'category', 'faults'])
    if (text(key) !== undefined && !csv(text(key))?.length)
      fail(`--${key} must not be empty`);
  const stores = csv(text('stores') ?? text('store'));
  if (stores && !stores.length) fail('--stores must not be empty');
  const known = new Set([
    'memory',
    ...Object.keys(CATALOG),
    ...Object.keys(CATALOG).map((s) => `${s}-netem`),
    ...Object.keys(readInfra().servers),
  ]);
  for (const s of stores ?? []) if (!known.has(s)) fail(`unknown store ${s}`);
  if (text('profile') && !(text('profile')! in PROFILES))
    fail(`unknown profile ${text('profile')}`);
  const sylvie = text('profile') === 'sylvie';
  if (sylvie && !['matrix', 'plan'].includes(command))
    fail('sylvie is supported by matrix and plan');
  const durations = ['duration', 'window', 'window-ms'].filter(
    (key) => v[key] !== undefined,
  );
  if (durations.length > 1)
    fail('use only one of --duration, --window, --window-ms');
  const windowSec = duration(text('duration') ?? text('window'), 'window');
  numberOption(text('jobs'), 'jobs', 2, 5000);
  numberOption(text('response-ms'), 'response-ms', 0, 100);
  numberOption(text('iterations'), 'iterations', 1, 1000);
  const options: TierOptions = {
    tier: (command === 'plan'
      ? text('profile') === 'smoke'
        ? 'smoke'
        : 'matrix'
      : command) as TierOptions['tier'],
    profile: text('profile') as ProfileName | undefined,
    suites: csv(text('suite')),
    stores,
    categories: csv(text('category')),
    faults: csv(text('faults')),
    base: text('base'),
    head: text('head'),
    current: v.current === true,
    patch: text('patch')
      ? resolve(process.env.INIT_CWD ?? process.cwd(), text('patch')!)
      : undefined,
    rebuild: v.rebuild === true ? true : undefined,
    reps: numberOption(text('reps'), 'reps', 1, 100),
    seed: numberOption(text('seed'), 'seed', 0, 0xffffffff),
    workers: numberOption(text('workers'), 'workers', 1, 64),
    rate: numberOption(text('rate'), 'rate', 0.001, 10000, false),
    windowMs:
      windowSec !== undefined
        ? windowSec * 1000
        : numberOption(text('window-ms'), 'window-ms', 1, 43200000),
    warmupMs: numberOption(text('warmup-ms'), 'warmup-ms', 0, 3600000),
    drainMs: numberOption(text('drain-ms'), 'drain-ms', 0, 3600000),
    limitCells: numberOption(text('limit-cells'), 'limit-cells', 1),
    cell: text('cell'),
    budgetSec: duration(text('budget'), 'budget'),
    dryRun: command === 'plan' || v['dry-run'] === true,
    yes: v.yes === true,
    isolate: sylvie || v.isolate === true,
    requireAuthoritative: sylvie || v['require-authoritative'] === true,
    workerCpus: cpus(text('worker-cpus')),
    endpoint: text('endpoint'),
    runId: text('run-id') ? safeId(text('run-id')!, 'run ID') : undefined,
    html: v.html === true,
    keepRaw: v['keep-raw'] === true,
    command: argv,
  };
  cpus(text('cpuset'));
  if (options.endpoint) {
    try {
      const url = new URL(options.endpoint);
      if (!['redis:', 'rediss:'].includes(url.protocol))
        fail('--endpoint must be a redis:// or rediss:// URL');
    } catch {
      fail('--endpoint must be a Redis URL');
    }
  }
  return { command, args, values: v, options };
}

/** Dispatch a validated command and return its documented process exit status. */
export async function main(
  argv = process.argv.slice(2),
  log: (line: string) => void = console.log,
): Promise<number> {
  const { command, args, values: v, options } = parseCli(argv);
  const text = (key: string) =>
    typeof v[key] === 'string' ? (v[key] as string) : undefined;
  if (command === 'help') {
    log(HELP);
    return 0;
  }
  if (options!.isolate && !options!.dryRun) {
    const code = reexecIsolated(
      [process.argv[1]!, ...argv],
      options!.profile === 'sylvie' ? SYLVIE_POLICY.maxGroupGiB + 1 : undefined,
    );
    if (code !== null) return code;
  }
  switch (command) {
    case 'doctor':
      return doctor(log);
    case 'calibrate':
      return calibrate(options!.reps ?? 3, log);
    case 'build': {
      if (v.patch && !v.ref) fail('build --patch requires --ref');
      log(
        encode(
          text('ref')
            ? refBuild(text('ref')!, {
                ...(options!.patch ? { patch: options!.patch } : {}),
              })
            : currentBuild({ rebuild: true }),
          2,
        ),
      );
      return 0;
    }
    case 'infra': {
      const [action, ...names] = args;
      if (
        !action ||
        !['up', 'down', 'status', 'adopt', 'images'].includes(action)
      )
        fail('infra requires up, down, status, adopt or images');
      if (action === 'adopt') {
        if (names.length !== 1 || !v['empty-only'])
          fail(
            'infra adopt URL requires --empty-only (and optional --name NAME)',
          );
        const url = new URL(names[0]!);
        if (!['redis:', 'rediss:'].includes(url.protocol))
          fail('adopt requires a Redis URL');
        log(
          encode(
            await adopt(
              safeId(text('name') ?? 'adopted', 'server name'),
              names[0]!,
            ),
            2,
          ),
        );
        return 0;
      }
      if (action === 'status') {
        if (names.length) fail('infra status takes no server arguments');
        const result = await status();
        log(encode(result, 2));
        return Object.values(result).some((s) => !s.reachable || !s.sentinel)
          ? 1
          : 0;
      }
      const selected = names.length
        ? names.flatMap((s) => s.split(','))
        : (csv(text('stores')) ??
          (action === 'down'
            ? Object.keys(readInfra().servers)
            : ['redis74', 'valkey8']));
      for (const name of selected)
        if (
          !CATALOG[name.replace(/-netem$/, '')] &&
          !(action === 'down' && readInfra().servers[name])
        )
          fail(`unknown infra server ${name}`);
      for (const name of selected) {
        if (action === 'up')
          log(
            encode(
              {
                [name]: await up(name, {
                  ...(text('cpuset') ? { cpuset: text('cpuset')! } : {}),
                  recreate: v.recreate === true,
                }),
              },
              2,
            ),
          );
        else if (action === 'down') {
          down(name);
          log(`removed ${name}`);
        } else {
          const tag = netemImage(name);
          log(
            encode({
              name,
              base: CATALOG[name.replace(/-netem$/, '')]!.image,
              netem: tag,
              available: v.build ? !!buildNetemImage(name) : hasImage(tag),
            }),
          );
        }
      }
      return 0;
    }
    case 'micro':
      return micro(
        {
          quick: v.quick === true,
          filter: text('filter'),
          rebuild: true,
        },
        log,
      );
    case 'footprint':
    case 'startup':
    case 'scoped':
    case 'drift':
      return measure(
        command,
        {
          base: options!.base,
          head: options!.head,
          check: v.check === true,
          reps: options!.reps,
          stores: options!.stores,
          jobs: text('jobs') === undefined ? undefined : Number(text('jobs')),
          responseMs:
            text('response-ms') === undefined
              ? undefined
              : Number(text('response-ms')),
          iterations:
            text('iterations') === undefined
              ? undefined
              : Number(text('iterations')),
        },
        log,
      );
    case 'model':
      return model(log);
    case 'quick':
      await model(log);
      return micro({ quick: true, filter: text('filter'), rebuild: true }, log);
    case 'plan': {
      if (options!.profile === 'sylvie') return runSylvie(options!, log);
      const plan = preparePlan(options!);
      printPlan(plan, log);
      if (!plan.cells.length)
        fail('No cells selected; adjust filters or budget');
      return 0;
    }
    case 'smoke':
    case 'matrix':
    case 'libs':
    case 'soak':
    case 'chaos':
      return options!.profile === 'sylvie'
        ? runSylvie(options!, log)
        : runTier(options!, log);
    case 'c1':
      return c1({ stores: options!.stores, endpoint: options!.endpoint }, log);
    case 'report': {
      if (args.length !== 1) fail('report requires exactly one run ID');
      const dir = runDir(safeId(args[0]!, 'run ID'));
      if (!existsSync(join(dir, 'summary.json'))) {
        const manifest = readManifest(args[0]!);
        const file =
          manifest.tier === 'calibrate'
            ? 'calibration-trials.json'
            : `${manifest.tier}.json`;
        const raw = readFileSync(join(dir, file), 'utf8');
        const c1Status =
          manifest.tier === 'c1'
            ? c1Safety(decode<C1Result[]>(raw))
            : undefined;
        const safety =
          c1Status === 'FAIL'
            ? 'FAIL - KNOWN DEFECT REPRODUCED'
            : c1Status === 'PASS'
              ? 'PASS - DEADLINE REGRESSION CHECK'
              : 'UNVERIFIED - local diagnostic tier';
        const markdown = `# Valve ${manifest.tier}: ${manifest.runId}\n\nSafety: ${safety}\n\nPortable local evidence. No distributed performance inference.\n\n\`\`\`json\n${raw}\n\`\`\`\n`;
        writeFileSync(join(dir, 'report.md'), markdown);
        if (v.html) {
          const escape = (text: string) =>
            text
              .replaceAll('&', '&amp;')
              .replaceAll('<', '&lt;')
              .replaceAll('>', '&gt;');
          writeFileSync(
            join(dir, 'report.html'),
            `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Valve local evidence</title><main><h1>Valve ${manifest.tier}</h1><p>Safety: ${safety}</p><p>Portable diagnostic evidence; no distributed performance inference.</p><pre>${escape(raw)}</pre></main></html>`,
          );
        }
        log(join(dir, v.html ? 'report.html' : 'report.md'));
        return 0;
      }
      const summary = decode<RunSummary>(
        readFileSync(join(dir, 'summary.json'), 'utf8'),
      );
      await writeReports(summary, dir, { html: v.html === true });
      log(join(dir, v.html ? 'report.html' : 'report.md'));
      return 0;
    }
    case 'legacy': {
      if (args.length !== 1) fail('legacy requires catalog or golden');
      if (args[0] === 'catalog')
        log(
          encode(
            await catalogArchive(
              resolve(
                text('archive') ||
                  process.env.VALVE_EVIDENCE_ARCHIVE ||
                  fail(
                    'legacy catalog requires --archive DIR or VALVE_EVIDENCE_ARCHIVE',
                  ),
              ),
            ),
            2,
          ),
        );
      else if (args[0] === 'golden')
        execFileSync('bash', [join(perfDir, 'scripts/legacy-golden.sh')], {
          cwd: perfDir,
          stdio: 'inherit',
          env: {
            ...process.env,
            ...(text('archive')
              ? { VALVE_EVIDENCE_ARCHIVE: resolve(text('archive')!) }
              : {}),
          },
        });
      else fail('legacy requires catalog or golden');
      return 0;
    }
    default:
      return fail(`unknown command ${command}`);
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = error instanceof UsageError ? 2 : 1;
    });
}
