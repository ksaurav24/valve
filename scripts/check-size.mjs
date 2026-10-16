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
  // Queue-order, shutdown, admission, store-contract and parsing fixes (#76-81)
  // together measure 12616 bytes for core and 6235 bytes for Redis (+gzip).
  // Keep the shared ceilings tight while allowing these fixes to merge together.
  ['index', 12700],
  ['redis/index', 6300],
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
