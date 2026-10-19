// Filesystem layout. Everything the harness writes lives under `<repo>/.perf` (git-ignored).
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** packages/perf */
export const perfDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);
/** Repository root (workspace root of this checkout). */
export const repoRoot = resolve(perfDir, '../..');
export const valveDir = join(repoRoot, 'packages/valve');
export const stateDir = process.env.VALVE_PERF_HOME ?? join(repoRoot, '.perf');
export const runsDir = join(stateDir, 'runs');
export const buildsDir = join(stateDir, 'builds');
export const infraFile = join(stateDir, 'infra.json');
export const calibrationFile = join(stateDir, 'calibration.json');
export const workerEntry = join(perfDir, 'src/driver/worker.ts');

export function ensureDir(path: string): string {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
  return path;
}
