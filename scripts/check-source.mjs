// Enforce portable source, writing conventions, and zero package dependencies.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'utf8' },
)
  .split('\0')
  // Git still lists tracked files deleted from the working tree.
  .filter((file) => file && existsSync(file));
const todos = JSON.parse(readFileSync('scripts/todo-register.json', 'utf8'));
let failed = false;
for (const file of files) {
  if (
    file === 'pnpm-lock.yaml' ||
    file.endsWith('.svg') ||
    file.endsWith('.png') ||
    file.endsWith('.gz')
  )
    continue;
  const source = readFileSync(file, 'utf8');
  if (/[\u2013\u2014]/u.test(source)) {
    console.error(`${file}: use plain punctuation instead of long dashes`);
    failed = true;
  }
  if (
    file.startsWith('packages/valve/src/') &&
    /(?:from\s*|import\s*\()['"]node:/u.test(source)
  ) {
    console.error(`${file}: core must use web standard APIs`);
    failed = true;
  }
  for (const line of source.split('\n')) {
    if (!line.trimStart().startsWith('// TODO')) continue;
    if (
      !/^\s*\/\/ TODO\((decision|verify|1\.0\.0)\): .+\./u.test(line) ||
      !todos.includes(line.trim().replace(/^\/\/ /u, ''))
    ) {
      console.error(`${file}: invalid TODO form`);
      failed = true;
    }
  }
}
const pkg = JSON.parse(readFileSync('packages/valve/package.json', 'utf8'));
if (
  Object.keys(pkg.dependencies ?? {}).length ||
  Object.keys(pkg.peerDependencies ?? {}).length
) {
  console.error('The library must have zero runtime and peer dependencies');
  failed = true;
}
if (failed) process.exit(1);
console.log(
  'Source conventions, runtime neutrality, and dependency checks passed.',
);
