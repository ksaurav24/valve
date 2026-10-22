// One pinned bundler and settings for both frozen builds; retain the source-size budgets.
import { build, version } from 'esbuild';
import { relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { BuildIdentity } from '../core/types.ts';

export const SIZE_BUDGETS = {
  // Managed admission and migration are included even for immutable consumers.
  core: 17500,
  redis: 12000,
  headers: 2048,
} as const;
export const BUNDLE_SETTINGS =
  'browser, esm, es2022, bundle, minify, gzip default level';
export const bundlerVersion = version;

export interface BundleRow {
  input: 'src' | 'dist';
  name: string;
  bytes: number;
  gzipBytes: number;
  modules: Record<string, number>;
}

/** Bundle source entries, built entries, and consumers with the same pinned settings. */
export async function bundleFootprint(
  artifact: BuildIdentity,
): Promise<BundleRow[]> {
  const base = artifact.packageDir;
  const rows: BundleRow[] = [];
  for (const input of ['src', 'dist'] as const) {
    const extension = input === 'src' ? 'ts' : 'js';
    const entries = {
      core: `./${input}/index.${extension}`,
      redis: `./${input}/redis/index.${extension}`,
      headers: `./${input}/headers/index.${extension}`,
    };
    const consumers = {
      valve: `import { createValve } from '${entries.core}'; globalThis.api = createValve({id:'api',concurrency:16});`,
      memory: `import { memoryStore } from '${entries.core}'; globalThis.store = memoryStore();`,
      errors: `import { isValveError } from '${entries.core}'; globalThis.isValveError = isValveError;`,
      redis: `import { redisStore } from '${entries.redis}'; globalThis.store = redisStore({adapter:globalThis.adapter});`,
      retryAfter: `import { retryAfter } from '${entries.headers}'; globalThis.feedback = retryAfter();`,
    };
    for (const [name, value] of [
      ...Object.entries(entries).map(
        ([name, path]) => [`entry/${name}`, path] as const,
      ),
      ...Object.entries(consumers).map(
        ([name, code]) => [`consumer/${name}`, code] as const,
      ),
    ]) {
      const result = await build({
        ...(name.startsWith('entry/')
          ? { entryPoints: [resolve(base, value)] }
          : {
              stdin: {
                contents: value,
                resolveDir: base,
                sourcefile: 'consumer.js',
              },
            }),
        bundle: true,
        minify: true,
        platform: 'browser',
        format: 'esm',
        target: 'es2022',
        write: false,
        metafile: true,
        legalComments: 'none',
      });
      const contents = result.outputFiles[0]!.contents;
      const modules = Object.values(result.metafile.outputs)[0]!.inputs;
      rows.push({
        input,
        name,
        bytes: contents.length,
        gzipBytes: gzipSync(contents).length,
        modules: Object.fromEntries(
          Object.entries(modules).map(([path, value]) => [
            relative(base, resolve(path)),
            value.bytesInOutput,
          ]),
        ),
      });
    }
  }
  return rows;
}

/** Missing or invalid entries fail closed, as do entries over the existing ceiling. */
export function sizeChecks(rows: BundleRow[]) {
  return Object.entries(SIZE_BUDGETS).map(([entry, budget]) => {
    const matches = rows.filter(
      (r) => r.input === 'src' && r.name === `entry/${entry}`,
    );
    const bytes = matches[0]?.gzipBytes;
    return {
      entry,
      budget,
      bytes,
      pass:
        matches.length === 1 &&
        Number.isSafeInteger(bytes) &&
        bytes! > 0 &&
        bytes! <= budget,
    };
  });
}
