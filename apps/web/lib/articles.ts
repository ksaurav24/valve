import { readFileSync } from 'node:fs';
import path from 'node:path';
import { articlesSource } from './source';

/** One publication list for the index, detail routes, and sitemap. */
export function getArticles() {
  return articlesSource
    .getPages()
    .filter((page) => !page.data.draft && page.slugs.length > 0)
    .sort(
      (a, b) =>
        b.data.date.localeCompare(a.data.date) || a.url.localeCompare(b.url),
    );
}

export type Article = ReturnType<typeof getArticles>[number];

const dateFormatter = new Intl.DateTimeFormat('en', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

export function formatArticleDate(date: string) {
  return dateFormatter.format(new Date(`${date}T00:00:00Z`));
}

const wordsPerMinute = 230;

/** Estimated from the MDX source: prose words plus code at half weight. */
export function readingMinutes(article: Article) {
  const file =
    article.absolutePath ??
    path.join(process.cwd(), 'content/articles', article.path);
  const source = readFileSync(file, 'utf8').replace(/^---[\s\S]*?---/, '');
  const code = source.match(/^```[\s\S]*?^```/gm) ?? [];
  const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
  const codeWords = code.reduce((sum, block) => sum + words(block), 0);
  const proseWords = words(source) - codeWords;
  return Math.max(1, Math.round((proseWords + codeWords / 2) / wordsPerMinute));
}
