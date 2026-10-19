import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const fixture = vi.hoisted(() => ({ root: '', state: '', builds: 0 }));
vi.mock('../src/core/paths.ts', async (original) => ({
  ...(await original<typeof import('../src/core/paths.ts')>()),
  get repoRoot() {
    return fixture.root;
  },
  get stateDir() {
    return fixture.state;
  },
  get buildsDir() {
    return join(fixture.state, 'builds');
  },
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(
      (
        command: string,
        args: string[],
        options: { cwd: string; encoding?: 'utf8' },
      ) => {
        if (command !== 'pnpm')
          return actual.execFileSync(command, args, options);
        if (args.includes('build')) {
          fixture.builds++;
          const root = options.cwd;
          mkdirSync(join(root, 'packages/valve/dist'), { recursive: true });
          cpSync(
            join(root, 'packages/valve/src/index.ts'),
            join(root, 'packages/valve/dist/index.js'),
          );
        }
        return '';
      },
    ),
  };
});
import { refBuild } from '../src/identity/build.ts';

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: fixture.root, encoding: 'utf8' }).trim();
beforeEach(() => {
  fixture.root = mkdtempSync(join(tmpdir(), 'valve-source-'));
  fixture.state = mkdtempSync(join(tmpdir(), 'valve-state-'));
  fixture.builds = 0;
  mkdirSync(join(fixture.root, 'packages/valve/src/redis'), {
    recursive: true,
  });
  writeFileSync(
    join(fixture.root, 'packages/valve/package.json'),
    '{"type":"module"}',
  );
  writeFileSync(join(fixture.root, 'pnpm-lock.yaml'), 'fixture-lock');
  writeFileSync(
    join(fixture.root, 'packages/valve/src/index.ts'),
    'export const value = 0;\n',
  );
  const sha = createHash('sha1').update('return 1').digest('hex');
  writeFileSync(
    join(fixture.root, 'packages/valve/src/redis/scripts.ts'),
    ['ACQUIRE', 'SCOPED', 'PAUSE', 'RESUME', 'RELEASE', 'RENEW']
      .map(
        (n) =>
          `export const ${n} = "return 1";\nexport const ${n}_SHA = '${sha}';`,
      )
      .join('\n'),
  );
  git('init', '--quiet');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.com');
  git('add', '.');
  git('commit', '--quiet', '-m', 'fixture');
});
afterEach(() => {
  rmSync(fixture.root, { recursive: true, force: true });
  rmSync(fixture.state, { recursive: true, force: true });
});

describe('isolated revision preparation', () => {
  it('re-verifies frozen caches outside any Git repository without rebuilding', () => {
    const first = refBuild('HEAD');
    expect(first.packageDir.startsWith(fixture.state)).toBe(true);
    expect(refBuild('HEAD')).toEqual(first);
    expect(fixture.builds).toBe(1);
  });
  it('never labels an unpatched retry as patched after a failed application', () => {
    const patch = join(fixture.state, 'bad.patch');
    writeFileSync(
      patch,
      'diff --git a/packages/valve/src/index.ts b/packages/valve/src/index.ts\n--- a/packages/valve/src/index.ts\n+++ b/packages/valve/src/index.ts\n@@ -1 +1 @@\n-export const value = 999;\n+export const value = 1;\n',
    );
    expect(() => refBuild('HEAD', { patch })).toThrow();
    expect(() => refBuild('HEAD', { patch })).toThrow();
    expect(fixture.builds).toBe(0);
    writeFileSync(
      patch,
      readFileSync(patch, 'utf8').replace('value = 999', 'value = 0'),
    );
    const build = refBuild('HEAD', { patch });
    expect(
      readFileSync(join(build.packageDir, 'dist/index.js'), 'utf8'),
    ).toContain('value = 1');
    expect(build.patchSha256).toBeDefined();
    expect(refBuild('HEAD', { patch })).toEqual(build);
    expect(fixture.builds).toBe(1);
  });
  it('recreates a half-prepared worktree with no completion marker', () => {
    const sha = git('rev-parse', 'HEAD'),
      key = sha.slice(0, 12);
    const tree = join(fixture.state, 'worktrees', key);
    mkdirSync(join(fixture.state, 'worktrees'));
    git('worktree', 'add', '--detach', tree, sha);
    writeFileSync(join(tree, 'packages/valve/src/index.ts'), 'wrong source');
    const build = refBuild('HEAD');
    expect(
      readFileSync(join(build.packageDir, 'dist/index.js'), 'utf8'),
    ).toContain('value = 0');
    expect(existsSync(`${tree}.ready`)).toBe(true);
  });
});
