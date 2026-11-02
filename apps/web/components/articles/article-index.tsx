import Link from 'next/link';
import { ArrowRight, ArrowUpRight } from 'lucide-react';
import { PageHeader } from '@/components/marketing/page-header';
import {
  formatArticleDate,
  readingMinutes,
  type Article,
} from '@/lib/articles';

export function ArticleIndex({ articles }: { articles: Article[] }) {
  const [latest, ...rest] = articles;
  return (
    <>
      <PageHeader
        eyebrow="articles"
        title="Articles"
        aside={
          articles.length > 0 ? (
            <p className="font-mono text-xs text-muted-foreground">
              {articles.length} {articles.length === 1 ? 'article' : 'articles'}
              , newest first
            </p>
          ) : null
        }
      >
        <p>
          Engineering articles on rate limiting, distributed systems, and
          Valve’s design.
        </p>
      </PageHeader>
      <section aria-label="Articles" className="page-gutter py-14 sm:py-20">
        {!latest ? (
          <div className="max-w-2xl space-y-5 rounded-md border border-border p-6 sm:p-10">
            <h2 className="text-2xl font-medium tracking-tight">
              No articles yet
            </h2>
            <p className="max-w-[55ch] leading-relaxed text-muted-foreground">
              Read the documentation for usage guides and API reference.
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
          <div className="mx-auto max-w-6xl">
            <FeaturedArticle article={latest} />
            {rest.length > 0 ? (
              <>
                <h2 className="mt-14 mb-2 text-sm font-medium text-muted-foreground sm:mt-16">
                  More articles
                </h2>
                <ol className="article-list">
                  {rest.map((article) => (
                    <ArticleRow key={article.url} article={article} />
                  ))}
                </ol>
              </>
            ) : null}
          </div>
        )}
      </section>
    </>
  );
}

function Meta({ article }: { article: Article }) {
  return (
    <>
      <time dateTime={article.data.date}>
        {formatArticleDate(article.data.date)}
      </time>
      <span aria-hidden="true">·</span>
      <span>{readingMinutes(article)} min read</span>
      {article.data.author ? (
        <>
          <span aria-hidden="true">·</span>
          <span>{article.data.author}</span>
        </>
      ) : null}
    </>
  );
}

function FeaturedArticle({ article }: { article: Article }) {
  return (
    <article className="article-feature group">
      <div aria-hidden="true" className="article-feature-grid bg-grid" />
      <div className="relative grid gap-10 p-6 sm:p-10 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end lg:gap-16 lg:p-14">
        <div className="min-w-0 space-y-6">
          <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-2 text-xs font-medium text-foreground">
              <span aria-hidden="true" className="live-dot" />
              Latest
            </span>
            <span aria-hidden="true">·</span>
            <Meta article={article} />
          </p>
          <h2 className="max-w-[22ch] text-balance text-[clamp(2rem,3.6vw,3.5rem)] font-medium leading-[1.06] tracking-[-0.045em]">
            <Link href={article.url} className="stretched-link break-words">
              {article.data.title}
            </Link>
          </h2>
          <p className="max-w-[58ch] text-lg leading-relaxed text-muted-foreground">
            {article.data.description}
          </p>
        </div>
        <span
          aria-hidden="true"
          className="article-cta inline-flex items-center gap-3 self-end text-sm font-medium"
        >
          Read article
          <span className="article-cta-icon">
            <ArrowRight className="size-4" />
          </span>
        </span>
      </div>
    </article>
  );
}

function ArticleRow({ article }: { article: Article }) {
  return (
    <li className="article-row group">
      <div className="min-w-0 space-y-3">
        <h3 className="text-xl font-medium leading-snug tracking-tight sm:text-2xl">
          <Link href={article.url} className="stretched-link break-words">
            {article.data.title}
          </Link>
        </h3>
        <p className="max-w-[65ch] leading-relaxed text-muted-foreground">
          {article.data.description}
        </p>
        <p className="flex flex-wrap gap-x-2 gap-y-1 text-sm text-muted-foreground lg:hidden">
          <Meta article={article} />
        </p>
      </div>
      <div className="hidden flex-col items-end gap-1.5 text-right text-sm text-muted-foreground lg:flex">
        <time dateTime={article.data.date}>
          {formatArticleDate(article.data.date)}
        </time>
        <span>{readingMinutes(article)} min read</span>
      </div>
      <ArrowUpRight aria-hidden="true" className="article-row-arrow size-4" />
    </li>
  );
}
