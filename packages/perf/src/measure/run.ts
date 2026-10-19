import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encode } from '../core/codec.ts';
import { runDir } from '../core/manifest.ts';
import { currentBuild, refBuild } from '../identity/build.ts';
import { localManifest } from '../tiers/local.ts';
import { resolveEndpoint } from '../infra/safety.ts';
import { imageId } from '../infra/servers.ts';
import {
  bundleFootprint,
  BUNDLE_SETTINGS,
  bundlerVersion,
  sizeChecks,
} from './bundle.ts';
import { driftSample, startupSample } from './process.ts';
import { scopedProbe } from './scoped.ts';

export type Measurement = 'footprint' | 'startup' | 'scoped' | 'drift';
export interface MeasurementOptions {
  base?: string | undefined;
  head?: string | undefined;
  check?: boolean;
  reps?: number | undefined;
  jobs?: number | undefined;
  responseMs?: number | undefined;
  iterations?: number | undefined;
  stores?: string[] | undefined;
}

/** Build both revisions before collecting descriptive samples and persisting their provenance. */
export async function measure(
  tier: Measurement,
  options: MeasurementOptions,
  log: (line: string) => void = console.log,
): Promise<number> {
  // Build both arms before measuring either. Never run tools from the baseline checkout.
  const builds = {
    ...(options.base ? { base: refBuild(options.base) } : {}),
    current: options.head ? refBuild(options.head) : currentBuild(),
  };
  const reps = options.reps ?? (tier === 'startup' || tier === 'drift' ? 3 : 1);
  const protocol =
    tier === 'footprint'
      ? `Same esbuild ${bundlerVersion} for both source and dist inputs; ${BUNDLE_SETTINGS}; unchanged source-entry budgets.`
      : tier === 'startup'
        ? 'Alternating build order each pair; ten fresh Node processes per entry per pair; shared filesystem caches; all samples retained.'
        : tier === 'drift'
          ? 'Alternating cold processes; 32 warmup jobs; 100/s GCRA burst 1; public Store wrapper; no injected timer/admission hooks.'
          : 'Public Store.acquireScoped; batches 1/32/128, rules 2/8/16, cold/hot/mixed; Redis contention 1/4/8 clients in one process. Denials are evaluations.';
  const runtime = {
    protocol,
    options,
    performance: 'DESCRIPTIVE',
    caveat:
      'Portable diagnostic measurements; no statistical regression or authoritative performance claim.',
  };
  const manifest = localManifest(tier, builds.current, {
    builds,
    reps,
    runtime,
    servers: Object.fromEntries(
      (tier === 'scoped' ? (options.stores ?? []) : [])
        .filter((name) => name !== 'memory')
        .map((name) => {
          const endpoint = resolveEndpoint(name);
          return [
            name,
            {
              image: endpoint.server ? imageId(endpoint.server) : 'external',
              url: endpoint.url,
              disposable: endpoint.disposable,
            },
          ];
        }),
    ),
  });
  const dir = runDir(manifest.runId);
  const samples: unknown[] = [];
  let failed = false;
  const record = (value: unknown) => {
    samples.push(value);
    writeFileSync(
      join(dir, `${tier}.json`),
      encode({ ...runtime, samples }, 2),
    );
  };
  if (tier === 'footprint') {
    for (const [arm, build] of Object.entries(builds)) {
      const rows = await bundleFootprint(build);
      const checks = sizeChecks(rows);
      record({ arm, rows, checks });
      for (const row of rows)
        log(`${arm} ${row.input} ${row.name}: ${row.gzipBytes} bytes gzip`);
      if (arm === 'current' && options.check)
        for (const check of checks) {
          log(
            `${check.pass ? 'PASS' : 'FAIL'} ${check.entry}: ${check.bytes} bytes gzip (budget ${check.budget})`,
          );
          if (!check.pass) failed = true;
        }
    }
  } else {
    for (let pair = 0; pair < reps; pair++) {
      const arms = Object.entries(builds);
      if (pair % 2) arms.reverse();
      for (const [arm, build] of arms) {
        log(`${tier}: pair ${pair + 1}/${reps} ${arm}`);
        if (tier === 'startup')
          for (const entry of ['core', 'redis', 'headers'] as const)
            for (let run = 0; run < 10; run++)
              record({ arm, pair, run, entry, ...startupSample(build, entry) });
        else if (tier === 'drift') {
          const sample = driftSample(
            build,
            options.jobs ?? 200,
            options.responseMs ?? 0,
          );
          if (sample.completed !== (options.jobs ?? 200))
            throw new Error('Drift probe lost callbacks');
          record({ arm, pair, ...sample });
        } else
          for (const store of options.stores ?? ['memory'])
            record({
              arm,
              pair,
              ...(await scopedProbe(build, {
                store,
                iterations: options.iterations ?? 100,
                prefix: `valve-perf-${manifest.runId}-${pair}-${arm}-${store}`,
              })),
            });
      }
    }
  }
  writeFileSync(
    join(dir, 'report.md'),
    `# Valve ${tier}\n\n${protocol}\n\n${runtime.caveat}\n\n${failed ? 'Size budget: FAIL.' : options.check ? 'Size budgets: PASS.' : 'Performance: DESCRIPTIVE.'}\n\nSee [raw samples](./${tier}.json) and [manifest](./manifest.json).\n`,
  );
  log(`Results: ${dir}`);
  return failed ? 1 : 0;
}
