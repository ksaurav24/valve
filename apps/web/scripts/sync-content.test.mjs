import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('content sync preserves release order, change paragraphs, and inline code', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'valve-content-'));
  try {
    const scripts = join(cwd, 'apps/web/scripts');
    await mkdir(scripts, { recursive: true });
    for (const file of ['sync-content.mjs', 'changelog.mjs']) {
      await cp(new URL(file, import.meta.url), join(scripts, file));
    }
    const pkg = join(cwd, 'packages/valve');
    await mkdir(pkg, { recursive: true });
    await writeFile(
      join(pkg, 'package.json'),
      JSON.stringify({ version: '1.2.3' }),
    );
    await writeFile(
      join(cwd, 'CONTRIBUTING.md'),
      '# Contributing\n\nHelp out.\n',
    );
    await writeFile(
      join(pkg, 'CHANGELOG.md'),
      `# valvejs

## 1.2.3

### Patch Changes

- abcdef0: Keep \`maxWait\` optional
  across all workers.

  Existing configurations remain valid.

- Another change.

## 1.2.2

### Minor Changes

- Older change.
`,
    );
    execFileSync(process.execPath, [join(scripts, 'sync-content.mjs')], {
      cwd,
    });
    const entries = JSON.parse(
      await readFile(join(cwd, 'apps/web/.generated/changelog.json'), 'utf8'),
    );
    assert.deepEqual(
      entries.map((entry) => entry.version),
      ['1.2.3', '1.2.2'],
    );
    assert.deepEqual(entries[0].sections, [
      {
        title: 'Patch Changes',
        items: [
          'Keep `maxWait` optional across all workers.\n\nExisting configurations remain valid.',
          'Another change.',
        ],
      },
    ]);
    const mdx = await readFile(
      join(cwd, 'apps/web/content/changelog/index.mdx'),
      'utf8',
    );
    assert.match(mdx, /Existing configurations remain valid\./);
    assert.match(mdx, /`maxWait`/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
