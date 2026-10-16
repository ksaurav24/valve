// Measure bundled, minified, gzipped entry points with their transitive imports.
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
const require = createRequire(
  new URL('../packages/valve/package.json', import.meta.url),
);
const { build } = require('esbuild');
const base = new URL('../packages/valve/', import.meta.url);
for (const [entry, budget] of [
  // Scoped admission adds the delayed heap, validation and a second Lua script.
  // Measured costs and the prior ceilings are recorded in bench/SCOPED.md.
  // Raised by 100 bytes for queue-order and shutdown fixes (#76, #77), which
  // together measured 12006 bytes.
  ['index', 12100],
  ['redis/index', 6200],
  ['headers/index', 2048],
]) {
  const result = await build({
    entryPoints: [new URL(`src/${entry}.ts`, base).pathname],
    bundle: true,
    minify: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    write: false,
  });
  const size = gzipSync(result.outputFiles[0].contents).length;
  console.log(`${entry}: ${size} bytes minified + gzip (budget ${budget})`);
  if (size > budget) process.exitCode = 1;
}
