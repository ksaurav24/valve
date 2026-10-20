// Sylvie defaults reuse the normal matrix, manifests, oracles and statistical rules.
import { execFileSync } from 'node:child_process';
import { CATALOG, down, readInfra, up } from '../infra/servers.ts';
import { endpointLockPath } from '../infra/safety.ts';
import { acquireEndpointLock } from '../infra/lock.ts';
import { sylvieCpus } from '../supervisor/isolate.ts';
import { preparePlan, runTier, type TierOptions } from './run.ts';

/** Run the isolated laptop preset, provisioning only a missing store and preserving reused stores. */
export async function runSylvie(
  options: TierOptions,
  log: (line: string) => void = console.log,
): Promise<number> {
  const stores = options.stores ?? ['redis74'];
  if (stores.length !== 1 || !CATALOG[stores[0]!] || options.endpoint)
    throw new Error(
      'sylvie needs one harness-owned Redis/Valkey store, without --endpoint',
    );
  const placement = sylvieCpus();
  const opts: TierOptions = {
    ...options,
    tier: 'matrix',
    profile: 'sylvie',
    stores,
    base: options.base ?? 'HEAD',
    workerCpus: options.workerCpus ?? placement.workerCpus,
    isolate: true,
    requireAuthoritative: true,
    html: options.html ?? true,
  };
  // Validate the plan before creating anything. Dry runs never touch Docker.
  if (!preparePlan(opts).cells.length)
    throw new Error('No sylvie cells selected; adjust filters or budget');
  log(
    `sylvie CPUs: server ${placement.serverCpus}; workers ${opts.workerCpus}; one thread per physical core`,
  );
  if (opts.dryRun) return runTier(opts, log);
  const name = stores[0]!;
  const previous = readInfra().servers[name];
  if (previous) {
    if (!previous.container || previous.cpuset !== placement.serverCpus)
      throw new Error(
        `sylvie needs ${name} pinned to CPU ${placement.serverCpus}; inspect infra before recreating it`,
      );
    acquireEndpointLock(endpointLockPath(previous.url), {
      runId: 'sylvie-preflight',
    })();
  } else {
    const existing = execFileSync(
      'docker',
      [
        'ps',
        '-a',
        '--filter',
        `name=^valve-perf-${name}$`,
        '--format',
        '{{.Names}}',
      ],
      { encoding: 'utf8' },
    ).trim();
    if (existing)
      throw new Error(
        `${existing} exists outside this checkout's registry; inspect it with perf infra before running sylvie`,
      );
  }
  try {
    if (!previous) await up(name, { cpuset: placement.serverCpus });
    return await runTier(opts, log);
  } finally {
    // Reused stores belong to the caller. Only remove the store created for this run.
    if (!previous && readInfra().servers[name]) {
      down(name);
      log(`sylvie cleanup: removed ${name}`);
    }
  }
}
