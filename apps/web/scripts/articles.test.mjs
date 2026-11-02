import assert from 'node:assert/strict';
import test from 'node:test';
import { articleSchema } from '../lib/article-schema.ts';

const article = {
  title: 'Admission under contention',
  description: 'How workers share a rate budget.',
  date: '2026-10-29',
};

test('article metadata requires a title, description, and calendar date', () => {
  for (const field of ['title', 'description', 'date']) {
    const missing = { ...article };
    delete missing[field];
    assert.equal(articleSchema.safeParse(missing).success, false, field);
    assert.equal(
      articleSchema.safeParse({ ...article, [field]: '' }).success,
      false,
      field,
    );
  }
  for (const date of ['2026-02-29', '2026-13-01', 'October 29, 2026']) {
    assert.equal(articleSchema.safeParse({ ...article, date }).success, false);
  }
  assert.equal(
    articleSchema.safeParse({ ...article, date: '2028-02-29' }).success,
    true,
  );
});

test('articles publish by default and explicit drafts retain their state', () => {
  assert.equal(articleSchema.parse(article).draft, false);
  assert.equal(articleSchema.parse({ ...article, draft: true }).draft, true);
  assert.equal(
    articleSchema.safeParse({ ...article, draft: 'false' }).success,
    false,
  );
});

test('author metadata is optional and rejects blank names', () => {
  assert.equal(articleSchema.parse(article).author, undefined);
  assert.equal(
    articleSchema.parse({ ...article, author: 'Valve maintainers' }).author,
    'Valve maintainers',
  );
  assert.equal(
    articleSchema.safeParse({ ...article, author: ' ' }).success,
    false,
  );
});
