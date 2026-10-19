/** Read-only catalog and integrity checks for the pre-harness evidence archive. */

import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const familyNames = [
  'thundering-herd',
  'slotexp-validation',
  'baseline',
  'drift-results',
  'footprint-results',
  'scoped-results',
  'top-level',
] as const;

/** Stable metadata describing the archived benchmark evidence. */
export interface ArchiveCatalog {
  archiveDir: string;
  sourceCommit: string;
  files: number;
  families: Record<(typeof familyNames)[number], number>;
  protocols: Array<
    'r3' | 'r4' | 'slotexp-v5' | 'baseline-2026-10-17' | 'tracked-reports'
  >;
}

/** Read the archive's metadata and per-file manifest without extracting it. */
export async function catalogArchive(
  archiveDir: string,
): Promise<ArchiveCatalog> {
  const [readme, manifest, sourceCommit] = await Promise.all([
    readFile(join(archiveDir, 'README.md'), 'utf8'),
    readFile(join(archiveDir, 'bench-files.sha256'), 'utf8'),
    readFile(join(archiveDir, 'source-commit.txt'), 'utf8'),
  ]);
  const lines = manifest.split('\n').filter(Boolean);
  const families = Object.fromEntries(
    familyNames.map((name) => [name, 0]),
  ) as ArchiveCatalog['families'];
  const paths = lines.map((line) => line.slice(line.indexOf('  ') + 2));
  for (const path of paths) {
    const relative = path.replace(/^bench\//, '');
    const family = relative.includes('/')
      ? relative.slice(0, relative.indexOf('/'))
      : 'top-level';
    if (family in families) families[family as keyof typeof families]++;
  }
  if (!readme.includes('Valve benchmark evidence archive')) {
    throw new Error(
      'Archive README does not describe Valve benchmark evidence',
    );
  }
  return {
    archiveDir,
    families,
    files: lines.length,
    protocols: [
      'r3',
      'r4',
      'slotexp-v5',
      'baseline-2026-10-17',
      'tracked-reports',
    ],
    sourceCommit: sourceCommit.trim(),
  };
}

/** Stream the archive tarball and compare it with its recorded SHA-256. */
export async function verifyArchive(
  archiveDir: string,
): Promise<'ok' | 'mismatch'> {
  const checksum = await readFile(
    join(archiveDir, 'bench.tar.zst.sha256'),
    'utf8',
  );
  const expected = checksum.trim().split(/\s+/, 1)[0];
  if (!expected) return 'mismatch';
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(join(archiveDir, 'bench.tar.zst')))
    hash.update(chunk);
  return hash.digest('hex') === expected ? 'ok' : 'mismatch';
}
