import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('Changesets validation works in a detached CI checkout without local master', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'valve-changesets-ci-'));
  const cli = fileURLToPath(
    new URL('../node_modules/@changesets/cli/bin.js', import.meta.url),
  );
  const workflow = readFileSync(
    new URL('../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  const section = workflow
    .split('      - name: Validate changesets\n')[1]
    .split('      - name: ')[0];
  const command = section.split('        run: |\n')[1].replace(/^ {10}/gm, '');
  const git = (...args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const write = (path, text) => writeFileSync(join(cwd, path), text);
  const commit = () => {
    git('add', '.');
    git('commit', '--quiet', '-m', 'fixture');
  };
  // Run the workflow's actual shell, using the installed CLI without a pnpm install.
  const validate = (base) =>
    spawnSync(
      'bash',
      [
        '-eo',
        'pipefail',
        '-c',
        `
    pnpm() { shift 2; "$TEST_NODE" "$TEST_CHANGESETS_CLI" "$@"; }
    ${command}
  `,
      ],
      {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          BASE_REF: base,
          TEST_NODE: process.execPath,
          TEST_CHANGESETS_CLI: cli,
        },
      },
    );
  try {
    git('init', '--quiet', '--initial-branch=fixture');
    git('config', 'user.name', 'CI regression');
    git('config', 'user.email', 'ci@example.com');
    mkdirSync(join(cwd, '.changeset'));
    mkdirSync(join(cwd, 'scripts'));
    mkdirSync(join(cwd, 'node_modules'));
    symlinkSync(
      fileURLToPath(new URL('../node_modules/semver', import.meta.url)),
      join(cwd, 'node_modules/semver'),
      'dir',
    );
    for (const name of [
      'prepare-release-plan.mjs',
      'validate-versioned-release.mjs',
    ])
      write(
        `scripts/${name}`,
        readFileSync(new URL(name, import.meta.url), 'utf8'),
      );
    mkdirSync(join(cwd, 'packages/valve'), { recursive: true });
    write(
      'package.json',
      JSON.stringify({
        name: 'ci-fixture',
        private: true,
        packageManager: 'pnpm@11.28.4',
      }),
    );
    write('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
    write(
      '.changeset/config.json',
      readFileSync(
        new URL('../.changeset/config.json', import.meta.url),
        'utf8',
      ),
    );
    write(
      'packages/valve/package.json',
      JSON.stringify({ name: 'valvejs', version: '0.2.0' }),
    );
    write('packages/valve/index.js', 'export {};\n');
    write('packages/valve/CHANGELOG.md', '# valvejs\n\n## 0.2.0\n');
    commit();
    const base = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/master', base);
    git('switch', '--detach', '--quiet');
    git('branch', '-D', 'fixture');
    assert.equal(
      git('for-each-ref', '--format=%(refname)', 'refs/heads/master'),
      '',
    );

    write('packages/valve/index.js', 'export const changed = true;\n');
    write(
      '.changeset/change.md',
      "---\n'valvejs': patch\n---\n\nFix a behavior.\n",
    );
    commit();
    const previous = spawnSync(process.execPath, [cli, 'status'], {
      cwd,
      encoding: 'utf8',
    });
    assert.notEqual(previous.status, 0);
    assert.match(
      previous.stdout + previous.stderr,
      /Failed to find where HEAD diverged from "master"/,
    );
    for (const ref of [base, 'origin/master']) {
      const result = validate(ref);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }

    // Maintenance and version PRs can legitimately have no new changesets.
    git('reset', '--hard', base);
    write('packages/valve/README.md', 'Documentation update.\n');
    write(
      'packages/valve/CHANGELOG.md',
      '# valvejs\n\n## 0.3.0\n\n- Update documentation.\n',
    );
    commit();
    assert.equal(validate(base).status, 0);
    write(
      'packages/valve/package.json',
      JSON.stringify({ name: 'valvejs', version: '0.3.0' }),
    );
    commit();
    assert.equal(validate(base).status, 0);

    write('.changeset/maintenance.md', '---\n---\n\nMaintenance only.\n');
    commit();
    const empty = validate(base);
    assert.equal(empty.status, 0, empty.stdout + empty.stderr);
    assert.doesNotMatch(empty.stdout, /- (major|minor|patch)/);

    // Invalid release notes must still fail instead of being silently skipped.
    write(
      '.changeset/broken.md',
      "---\n'unknown-package': patch\n---\n\nInvalid package.\n",
    );
    commit();
    const invalid = validate(base);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stdout + invalid.stderr, /unknown-package/);

    // A prepared release consumes its notes instead of leaving active changesets.
    // The workflow must still reject missing release notes and version downgrades.
    git('reset', '--hard', base);
    write(
      'packages/valve/package.json',
      JSON.stringify({ name: 'valvejs', version: '0.4.0' }),
    );
    commit();
    const missingNotes = validate(base);
    assert.notEqual(missingNotes.status, 0);
    assert.match(missingNotes.stdout + missingNotes.stderr, /newest changelog/);
    write(
      'packages/valve/CHANGELOG.md',
      '# valvejs\n\n## 0.4.0\n\n- Atomic scoped limits.\n',
    );
    commit();
    const prepared = validate(base);
    assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
    assert.match(prepared.stdout, /Validated prepared release/);
    write(
      'packages/valve/package.json',
      JSON.stringify({ name: 'valvejs', version: '0.1.0' }),
    );
    commit();
    const downgrade = validate(base);
    assert.notEqual(downgrade.status, 0);
    assert.match(
      downgrade.stdout + downgrade.stderr,
      /greater than the previous version/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
