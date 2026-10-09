import { mkdir, readFile, writeFile } from 'node:fs/promises';

// Changesets owns the package changelog. Never maintain a second copy by hand.
const input = new URL('../../packages/valve/CHANGELOG.md', import.meta.url);
const output = new URL('../.generated/changelog/index.mdx', import.meta.url);
const markdown = await readFile(input, 'utf8');
const version = markdown.match(/^## (\d+\.\d+\.\d+(?:-[\w.-]+)?)\s*$/m)?.[1];
if (!version) throw new Error('The package changelog has no version heading.');
await mkdir(new URL('.', output), { recursive: true });
await writeFile(
  output,
  '---\ntitle: Changelog\ndescription: Changes recorded in the package changelog.\n---\n\n' +
    markdown.replace(/^# [^\n]+\n\s*/, ''),
);
await writeFile(
  new URL('../.generated/release.json', import.meta.url),
  JSON.stringify({ version }) + '\n',
);
