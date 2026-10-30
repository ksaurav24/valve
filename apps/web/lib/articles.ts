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
