import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { prepareReleasePlan } from './prepare-release-plan.mjs';

test('Changesets exits beta mode once and subsequent releases use plain versions', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'valve-plain-versioning-'));
  const cli = fileURLToPath(
    new URL('../node_modules/@changesets/cli/bin.js', import.meta.url),
  );
  const run = (...args) =>
    execFileSync(process.execPath, [cli, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const write = (path, data) => writeFileSync(join(cwd, path), data);
  const read = (path) => readFileSync(join(cwd, path), 'utf8');
  try {
    mkdirSync(join(cwd, '.changeset/pre'), { recursive: true });
    mkdirSync(join(cwd, 'packages/valve'), { recursive: true });
    write('package.json', JSON.stringify({ name: 'fixture', private: true }));
    write('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
    write(
      '.changeset/config.json',
      readFileSync(new URL('../.changeset/config.json', import.meta.url)),
    );
    write('.changeset/pre.json', JSON.stringify({ mode: 'pre', tag: 'beta' }));
    write(
      '.changeset/pre/scoped.md',
      "---\n'valvejs': minor\n---\n\nAtomic scoped limits.\n",
    );
    write(
      'packages/valve/package.json',
      JSON.stringify({
        name: 'valvejs',
        version: '0.4.0-beta.0',
        publishConfig: { access: 'public' },
      }),
    );
    write(
      'packages/valve/CHANGELOG.md',
      '# valvejs\n\n## 0.4.0-beta.0\n\n- Atomic scoped limits.\n',
    );
    run('pre', 'exit');
    run('version');
    assert.equal(
      JSON.parse(read('packages/valve/package.json')).version,
      '0.4.0',
    );
    assert.equal(existsSync(join(cwd, '.changeset/pre.json')), false);
    assert.equal(existsSync(join(cwd, '.changeset/pre/scoped.md')), false);
    assert.match(read('packages/valve/CHANGELOG.md'), /^## 0\.4\.0$/m);
    assert.match(read('packages/valve/CHANGELOG.md'), /^## 0\.4\.0-beta\.0$/m);

    write(
      '.changeset/fix.md',
      "---\n'valvejs': patch\n---\n\nFix a behavior.\n",
    );
    run('version');
    const pkg = JSON.parse(read('packages/valve/package.json'));
    assert.equal(pkg.version, '0.4.1');
    assert.equal(existsSync(join(cwd, '.changeset/fix.md')), false);
    assert.equal(existsSync(join(cwd, '.changeset/pre.json')), false);
    assert.deepEqual(
      [...read('packages/valve/CHANGELOG.md').matchAll(/^## (\S+)$/gm)].map(
        (m) => m[1],
      ),
      ['0.4.1', '0.4.0', '0.4.0-beta.0'],
    );
    const plan = prepareReleasePlan(
      {
        version: 1,
        plan: [
          [
            {
              kind: 'publish',
              name: pkg.name,
              version: pkg.version,
              access: 'public',
              tag: 'latest',
            },
          ],
        ],
      },
      pkg,
    );
    assert.equal(plan.plan[0][0].tag, 'latest');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
