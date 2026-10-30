import Link from 'next/link';
import { PageHeader } from '@/components/marketing/page-header';
import { formatArticleDate, type Article } from '@/lib/articles';

export function ArticleIndex({ articles }: { articles: Article[] }) {
  return (
    <>
      <PageHeader eyebrow="articles" title="Articles">
        <p>Notes on rate limiting, distributed systems, and building valve.</p>
      </PageHeader>
      <section aria-label="Articles" className="page-gutter py-14 sm:py-20">
        {articles.length === 0 ? (
          <div className="max-w-2xl space-y-5 rounded-md border border-border p-6 sm:p-10">
            <h2 className="text-2xl font-medium tracking-tight">
              No articles yet
            </h2>
            <p className="max-w-[55ch] leading-relaxed text-muted-foreground">
              In the meantime, explore the documentation or see what changed in
              the latest releases.
            </p>
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm font-medium">
              <Link
                href="/docs"
                className="inline-flex min-h-11 items-center underline decoration-ring underline-offset-4 hover:decoration-foreground"
              >
                Read the documentation
              </Link>
              <Link
                href="/releases"
                className="inline-flex min-h-11 items-center underline decoration-ring underline-offset-4 hover:decoration-foreground"
              >
                View releases
              </Link>
            </div>
          </div>
        ) : (
          <ol className="max-w-5xl divide-y divide-border border-y border-border">
            {articles.map((article) => (
              <li
                key={article.url}
                className="grid gap-4 py-8 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-10 sm:py-10"
              >
                <div className="space-y-2 text-sm text-muted-foreground">
                  <time dateTime={article.data.date}>
                    {formatArticleDate(article.data.date)}
                  </time>
                  {article.data.author ? <p>{article.data.author}</p> : null}
                </div>
                <article className="min-w-0 space-y-4">
                  <h2 className="text-2xl font-medium leading-snug tracking-tight sm:text-3xl">
                    <Link
                      href={article.url}
                      className="break-words hover:underline hover:decoration-ring hover:underline-offset-4"
                    >
                      {article.data.title}
                    </Link>
                  </h2>
                  <p className="max-w-[65ch] leading-relaxed text-muted-foreground">
                    {article.data.description}
                  </p>
                  <Link
                    href={article.url}
                    className="inline-flex min-h-11 items-center text-sm font-medium underline decoration-ring underline-offset-4 hover:decoration-foreground"
                  >
                    Read article
                    <span className="sr-only">: {article.data.title}</span>
                  </Link>
                </article>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
