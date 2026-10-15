import assert from 'node:assert/strict';
import test from 'node:test';
import { plainVersionChangelog } from './changelog.mjs';

test('website history omits old prereleases without inventing plain releases', () => {
  const current = '## 0.4.0\n\n### Minor Changes\n\n- Scoped limits.\n\n';
  const old = '## 0.2.0\n\n- Older notes.\n';
  const result = plainVersionChangelog(
    '# valvejs\n\n' +
      current +
      '## 0.4.0-beta.0\n\n- Scoped preview.\n\n' +
      '## 0.3.0-beta.1\n\n- Preview fixes.\n\n' +
      '## 0.3.0-beta.0\n\n- Earlier preview.\n\n' +
      old,
  );
  assert.equal(result, '# valvejs\n\n' + current + old);
  assert.doesNotMatch(result, /0\.3\.0/);
});

test('all prerelease suffixes are omitted and plain notes remain unchanged', () => {
  const notes = '## 1.0.0\n\n- Upgrade from 1.0.0-rc.1.\n';
  assert.equal(
    plainVersionChangelog(
      notes + '\n## 1.0.0-rc.1\n\n- Preview.\n\n## 0.0.0-stage\n\n- Stage.\n',
    ),
    notes + '\n',
  );
  assert.equal(
    plainVersionChangelog('No version entries.\n'),
    'No version entries.\n',
  );
  assert.equal(plainVersionChangelog('## 0.4.0-beta.0\n\n- Preview.\n'), '');
});
