// Run manifests: everything needed to reproduce a run and to refuse stale or mixed rows.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decode, encode } from './codec.ts';
import { objectHash } from './hash.ts';
import { atomicWrite } from './files.ts';
import type { Fingerprint } from './fingerprint.ts';
import type { BuildIdentity, CellSpec, DecisionPlan } from './types.ts';
import { ensureDir, runsDir } from './paths.ts';

export interface RunManifest {
  version: 1;
  runId: string;
  tier:
    | 'micro'
    | 'model'
    | 'smoke'
    | 'matrix'
    | 'libs'
    | 'soak'
    | 'chaos'
    | 'c1'
    | 'footprint'
    | 'startup'
    | 'scoped'
    | 'drift'
    | 'calibrate';
  profile: string;
  createdAt: string;
  command: string[];
  harnessSha256: string;
  fingerprintId: string;
  fingerprint: Fingerprint;
  authoritative: boolean;
  authoritativeReasons: string[];
  builds: Record<string, BuildIdentity>;
  arms: { name: string; build: string; instrument: 'none' | 'correctness' }[];
  cells: { spec: CellSpec; hash: string }[];
  reps: number;
  baseSeed: number;
  decision?: DecisionPlan;
  /** Hash of everything that must be identical to resume this run. */
  planHash: string;
  estimateSec: number;
  servers: Record<string, { image: string; url: string; disposable: boolean }>;
  runtime?: Record<string, unknown>;
}

export const cellHash = (cell: CellSpec) => objectHash(cell);

/** Hash the immutable measurement inputs used to reject incompatible resumes. */
export function planHash(
  m: Omit<RunManifest, 'planHash' | 'createdAt' | 'command' | 'estimateSec'>,
): string {
  return objectHash({
    harness: m.harnessSha256,
    fingerprint: m.fingerprintId,
    builds: Object.fromEntries(
      Object.entries(m.builds).map(([k, b]) => [
        k,
        {
          dist: b.distSha256,
          source: b.sourceSha256,
          patch: b.patchSha256,
          lock: b.lockSha256,
          lua: b.luaSha1,
          node: b.node,
        },
      ]),
    ),
    authoritative: m.authoritative,
    servers: m.servers,
    runtime: m.runtime,
    arms: m.arms,
    cells: m.cells.map((c) => c.hash),
    reps: m.reps,
    baseSeed: m.baseSeed,
    decision: m.decision ?? null,
  });
}

export const runDir = (runId: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId))
    throw new Error('invalid run ID');
  return join(runsDir, runId);
};

/** Atomically create a run manifest, refusing to reuse an ID with a different plan. */
export function writeManifest(m: RunManifest): string {
  const dir = ensureDir(runDir(m.runId));
  const path = join(dir, 'manifest.json');
  if (existsSync(path)) {
    const old = decode<RunManifest>(readFileSync(path, 'utf8'));
    if (old.planHash !== m.planHash)
      throw new Error(
        `Refusing to reuse run ${m.runId}: plan hash ${old.planHash} differs from ${m.planHash} (code, builds, cells, fingerprint or decision plan changed). Start a new run.`,
      );
    return path;
  }
  atomicWrite(path, encode(m, 2));
  return path;
}

/** Read a run's persisted identity without changing its recorded provenance. */
export function readManifest(runId: string): RunManifest {
  return decode<RunManifest>(
    readFileSync(join(runDir(runId), 'manifest.json'), 'utf8'),
  );
}
