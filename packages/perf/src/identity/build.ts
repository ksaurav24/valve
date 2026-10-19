// Build identities: a Valve artifact is identified by content (dist file hashes), not by name.
// Builds of other refs happen in harness-owned git worktrees under .perf/worktrees.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  cpSync,
  mkdtempSync,
  renameSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { decode, encode } from '../core/codec.ts';
import { fileSha256, sha256 } from '../core/hash.ts';
import {
  buildsDir,
  ensureDir,
  perfDir,
  repoRoot,
  stateDir,
  valveDir,
} from '../core/paths.ts';
import type { BuildIdentity } from '../core/types.ts';
import { loadScripts } from '../lua/sources.ts';

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out.sort();
}

/** Hash every file of `packageDir/dist` and the shipped Lua; return the identity. */
export function identify(
  packageDir: string,
  label: string,
  extra: Partial<BuildIdentity> = {},
): BuildIdentity {
  const dist = join(packageDir, 'dist');
  if (!existsSync(join(dist, 'index.js')))
    throw new Error(`No build at ${dist}; build valvejs first.`);
  const files: Record<string, string> = {};
  for (const f of walk(dist)) files[relative(packageDir, f)] = fileSha256(f);
  const sourceFiles = Object.fromEntries(
    walk(join(packageDir, 'src')).map((f) => [
      relative(packageDir, f),
      fileSha256(f),
    ]),
  );
  const root = resolve(packageDir, '../..');
  const scripts = loadScripts(packageDir);
  return {
    label,
    gitSha: git(root, ['rev-parse', 'HEAD']),
    dirty: false,
    packageDir,
    distSha256: sha256(
      Object.entries(files)
        .map(([k, v]) => `${k}\0${v}`)
        .join('\n'),
    ),
    files,
    sourceFiles,
    sourceSha256: sha256(JSON.stringify(sourceFiles)),
    lockSha256: fileSha256(join(root, 'pnpm-lock.yaml')),
    luaSha1: Object.fromEntries(
      Object.values(scripts).map((s) => [s.name, s.sha]),
    ),
    builtAt: new Date(statSync(join(dist, 'index.js')).mtimeMs).toISOString(),
    node: process.version,
    ...extra,
  };
}

/** The Valve package of this checkout. Rebuilds when asked or when dist is missing. */
export function currentBuild(
  options: { rebuild?: boolean } = {},
): BuildIdentity {
  if (options.rebuild !== false || !existsSync(join(valveDir, 'dist/index.js')))
    execFileSync('pnpm', ['--filter', 'valvejs', 'build'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
  const diff = git(repoRoot, [
    'diff',
    'HEAD',
    '--',
    'packages/valve/src',
    'packages/valve/package.json',
  ]);
  const untracked = git(repoRoot, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    'packages/valve/src',
  ]);
  const dirty = diff.length > 0 || untracked.length > 0;
  return freezeBuild(
    identify(valveDir, 'current', {
      dirty,
      ...(dirty ? { diffSha256: sha256(diff + '\0' + untracked) } : {}),
    }),
  );
}

/** Freeze the exact measured artifact so subsequent builds cannot change an in-flight arm. */
function freezeBuild(identity: BuildIdentity): BuildIdentity {
  const parent = ensureDir(join(buildsDir, 'artifacts'));
  const key = sha256(
    identity.distSha256 +
      identity.sourceSha256 +
      identity.lockSha256 +
      JSON.stringify(identity.luaSha1),
  );
  const root = join(parent, key);
  const packageDir = join(root, 'packages/valve');
  if (!existsSync(root)) {
    const temporary = mkdtempSync(join(parent, '.snapshot-'));
    const target = ensureDir(join(temporary, 'packages/valve'));
    cpSync(join(identity.packageDir, 'dist'), join(target, 'dist'), {
      recursive: true,
    });
    cpSync(
      join(identity.packageDir, 'package.json'),
      join(target, 'package.json'),
    );
    cpSync(join(identity.packageDir, 'src'), join(target, 'src'), {
      recursive: true,
    });
    cpSync(
      resolve(identity.packageDir, '../../pnpm-lock.yaml'),
      join(temporary, 'pnpm-lock.yaml'),
    );
    for (const [file, hash] of Object.entries({
      ...identity.files,
      ...identity.sourceFiles,
    }))
      if (fileSha256(join(target, file)) !== hash)
        throw new Error(
          'Build changed while snapshotting; retry after the build completes',
        );
    try {
      renameSync(temporary, root);
    } catch (error) {
      if (!existsSync(root)) throw error;
    }
  }
  for (const [file, hash] of Object.entries({
    ...identity.files,
    ...identity.sourceFiles,
  }))
    if (fileSha256(join(packageDir, file)) !== hash)
      throw new Error(`Frozen artifact is corrupted: ${file}`);
  return { ...identity, packageDir };
}

/**
 * Build `ref` (optionally with a patch applied) in a dedicated worktree and cache the identity.
 * The main checkout is never modified.
 */
export function refBuild(
  ref: string,
  options: { patch?: string; label?: string } = {},
): BuildIdentity {
  const sha = git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`]);
  const patchText = options.patch
    ? readFileSync(options.patch, 'utf8')
    : undefined;
  const patchSha256 = patchText ? sha256(patchText) : undefined;
  const key = `${sha.slice(0, 12)}${patchSha256 ? `-p${patchSha256.slice(0, 12)}` : ''}`;
  const cached = join(ensureDir(buildsDir), `${key}.json`);
  if (existsSync(cached)) {
    const id = decode<BuildIdentity>(readFileSync(cached, 'utf8'));
    // Re-verify content: a cached identity is only reused if its files still hash the same.
    const again = identify(id.packageDir, id.label, {
      ...(patchSha256 ? { patchSha256 } : {}),
    });
    if (
      again.distSha256 === id.distSha256 &&
      again.sourceSha256 === id.sourceSha256 &&
      again.lockSha256 === id.lockSha256 &&
      JSON.stringify(again.luaSha1) === JSON.stringify(id.luaSha1)
    )
      return id;
  }
  const tree = join(stateDir, 'worktrees', key);
  if (!existsSync(tree)) {
    git(repoRoot, ['worktree', 'add', '--detach', tree, sha]);
    if (options.patch) git(tree, ['apply', '--index', resolve(options.patch)]);
  }
  execFileSync(
    'pnpm',
    [
      'install',
      '--frozen-lockfile',
      '--prefer-offline',
      '--filter',
      'valvejs...',
    ],
    {
      cwd: tree,
      stdio: 'inherit',
    },
  );
  execFileSync('pnpm', ['--filter', 'valvejs', 'build'], {
    cwd: tree,
    stdio: 'inherit',
  });
  const id = freezeBuild(
    identify(
      join(tree, 'packages/valve'),
      options.label ?? (patchSha256 ? `${ref}+patch` : ref),
      {
        ...(patchSha256 ? { patchSha256 } : {}),
      },
    ),
  );
  writeFileSync(cached, encode(id, 2));
  return id;
}

/** Hash of the harness source itself (part of every plan hash). */
export function harnessSha256(): string {
  const files = walk(join(perfDir, 'src')).filter((f) => f.endsWith('.ts'));
  files.push(join(perfDir, 'package.json'));
  return sha256(
    files.map((f) => `${relative(perfDir, f)}\0${fileSha256(f)}`).join('\n'),
  );
}

/** Absolute file URL of a build's entry modules. */
export function entryUrls(build: BuildIdentity) {
  const url = (p: string) =>
    new URL(`file://${join(build.packageDir, p)}`).href;
  return {
    index: url('dist/index.js'),
    redis: url('dist/redis/index.js'),
    headers: url('dist/headers/index.js'),
  };
}
