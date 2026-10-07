// Pack with pnpm, then validate both declaration module formats with attw.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'valve-pack-'));
try {
  execFileSync('pnpm', ['pack', '--out', join(directory, 'valve.tgz')], {
    stdio: 'inherit',
  });
  const archive = join(
    directory,
    readdirSync(directory).find((file) => file.endsWith('.tgz')),
  );
  execFileSync('pnpm', ['exec', 'attw', '--profile', 'node16', archive], {
    stdio: 'inherit',
  });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
