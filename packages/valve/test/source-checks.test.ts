// Source-convention checks reject planted violations without touching user files.
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
const root = fileURLToPath(new URL('../../../', import.meta.url));
it.each([
  String.fromCharCode(0x2014),
  String.fromCharCode(0x2013),
  '// TODO(invalid): fix this.',
  '// TODO(decision): Unregistered question. Default used: none.',
])('rejects a planted source convention violation', (text) => {
  const path = `${root}.valve-source-check-${process.pid}.ts`;
  writeFileSync(path, text);
  try {
    expect(() =>
      execFileSync(process.execPath, ['scripts/check-source.mjs'], {
        cwd: root,
        stdio: 'pipe',
      }),
    ).toThrow();
  } finally {
    unlinkSync(path);
  }
});
