// Minify Lua and hash its shipped source without runtime crypto or dependencies.
import { format } from 'prettier';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import luamin from 'luamin';
const base = new URL('../packages/valve/src/redis/', import.meta.url);
let output = '// Generated Lua sources and build-time SHA1 digests.\n';
for (const name of ['acquire', 'pause', 'resume', 'release', 'renew']) {
  const source = luamin.minify(
    await readFile(new URL(`${name}.lua`, base), 'utf8'),
  );
  output += `export const ${name.toUpperCase()} = ${JSON.stringify(source)};\nexport const ${name.toUpperCase()}_SHA = '${createHash('sha1').update(source).digest('hex')}';\n`;
}
await writeFile(
  new URL('scripts.ts', base),
  await format(output, {
    parser: 'typescript',
    singleQuote: true,
    trailingComma: 'all',
  }),
);
