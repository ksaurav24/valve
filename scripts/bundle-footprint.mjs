// Compare entry points and tree-shaken consumers with identical build settings.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import { cpus, platform, arch } from 'node:os';
const require = createRequire(
  new URL('../packages/valve/package.json', import.meta.url),
);
const { build, version } = require('esbuild');
const [root, output] = process.argv.slice(2);
if (!root || !output)
  throw new Error('Usage: bundle-footprint.mjs REPOSITORY OUTPUT');
const base = resolve(root, 'packages/valve');
const rows = [];
for (const input of ['src', 'dist']) {
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
  for (const [name, path] of [
    ...Object.entries(entries).map(([name, path]) => [`entry/${name}`, path]),
    ...Object.entries(consumers).map(([name, code]) => [
      `consumer/${name}`,
      code,
    ]),
  ]) {
    const result = await build({
      ...(name.startsWith('entry/')
        ? { entryPoints: [resolve(base, path)] }
        : {
            stdin: {
              contents: path,
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
    const contents = result.outputFiles[0].contents;
    const modules = Object.entries(result.metafile.outputs)[0][1].inputs;
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
writeFileSync(
  output,
  JSON.stringify(
    {
      root: resolve(root),
      node: process.version,
      esbuild: version,
      host: { cpu: cpus()[0].model, platform: platform(), arch: arch() },
      settings: 'browser, esm, es2022, bundle, minify, gzip default level',
      rows,
    },
    null,
    2,
  ) + '\n',
);
for (const row of rows)
  console.log(`${row.input} ${row.name}: ${row.gzipBytes} bytes gzip`);
