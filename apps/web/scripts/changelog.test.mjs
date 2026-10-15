import assert from 'node:assert/strict';
import test from 'node:test';
import { websiteChangelog } from './changelog.mjs';

test('preview-only changes are grouped under plain headings in source order', () => {
  const current = '## 0.4.0\n\n### Minor Changes\n\n- Scoped limits.\n\n';
  const old = '## 0.2.0\n\n- Older notes.\n';
  const result = websiteChangelog(
    '# valvejs\n\n' +
      current +
      '## 0.4.0-beta.0\n\n- Duplicate scoped preview.\n\n' +
      '## 0.3.0-beta.1\n\n### Patch Changes\n\n- Preview fixes.\n\n' +
      '## 0.3.0-beta.0\n\n### Minor Changes\n\n- Shared configuration.\n\n' +
      old,
  );
  assert.deepEqual(
    [...result.body.matchAll(/^## (.+)$/gm)].map((match) => match[1]),
    ['0.4.0', '0.3.0', '0.2.0'],
  );
  assert.ok(result.body.startsWith('# valvejs\n\n' + current));
  assert.ok(result.body.endsWith(old));
  assert.match(result.body, /Historical preview notes/);
  assert.match(result.body, /a plain npm release was not published/);
  assert.match(result.body, /Preview fixes/);
  assert.match(result.body, /Shared configuration/);
  assert.doesNotMatch(result.body, /Duplicate scoped preview/);
  assert.doesNotMatch(result.body, /-beta/);
  assert.deepEqual(result.historicalVersions, {
    '0.3.0': ['0.3.0-beta.1', '0.3.0-beta.0'],
  });
});

test('a later plain entry supersedes earlier preview entries without duplicating notes', () => {
  const result = websiteChangelog(
    '## 1.0.0-rc.1\n\n- Preview.\n\n## 1.0.0\n\n- Final notes.\n',
  );
  assert.equal(result.body, '## 1.0.0\n\n- Final notes.\n');
  assert.deepEqual(result.historicalVersions, {});
});

test('plain notes and source links are unchanged; preview-only history is never lost', () => {
  const notes = '## 1.0.0\n\n- Upgrade from 1.0.0-rc.1.\n';
  assert.equal(websiteChangelog(notes).body, notes);
  assert.equal(
    websiteChangelog('No version entries.\n').body,
    'No version entries.\n',
  );
  const preview = websiteChangelog('## 0.4.0-beta.0\n\n- Preview notes.\n');
  assert.match(preview.body, /^## 0\.4\.0$/m);
  assert.match(preview.body, /Preview notes/);
  assert.deepEqual(preview.historicalVersions, { '0.4.0': ['0.4.0-beta.0'] });
});
