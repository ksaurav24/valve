import Link from 'next/link';
import { formatArticleDate, type Article } from '@/lib/articles';
import { getMDXComponents } from '@/mdx-components';

export function ArticleDetail({ article }: { article: Article }) {
  const Content = article.data.body;

  return (
    <div className="page-gutter py-10 sm:py-14">
      <Link
        href="/articles"
        className="inline-flex min-h-11 items-center text-sm text-muted-foreground underline decoration-ring underline-offset-4 hover:text-foreground"
      >
        All articles
      </Link>
      <div className="mt-8 grid items-start gap-12 xl:grid-cols-[minmax(0,75ch)_minmax(12rem,1fr)] xl:gap-20">
        <article className="min-w-0 max-w-[75ch]">
          <header className="space-y-6 border-b border-border pb-10">
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
              <time dateTime={article.data.date}>
                {formatArticleDate(article.data.date)}
              </time>
              {article.data.author ? <span>{article.data.author}</span> : null}
            </div>
            <h1 className="break-words text-balance text-[clamp(2.5rem,5vw,4.5rem)] font-medium leading-[1.08] tracking-[-0.045em]">
              {article.data.title}
            </h1>
            <p className="text-lg leading-relaxed text-muted-foreground sm:text-xl">
              {article.data.description}
            </p>
          </header>
          <div className="prose mt-10 min-w-0 max-w-none break-words [&_h2]:scroll-mt-24 [&_h3]:scroll-mt-24">
            <Content components={getMDXComponents()} />
          </div>
          <footer className="mt-14 flex flex-wrap gap-x-8 gap-y-2 border-t border-border pt-6 text-sm font-medium">
            <Link
              href="/articles"
              className="inline-flex min-h-11 items-center hover:underline"
            >
              All articles
            </Link>
            <Link
              href="/docs"
              className="inline-flex min-h-11 items-center hover:underline"
            >
              Documentation
            </Link>
          </footer>
        </article>
        {article.data.toc.length > 0 ? (
          <aside className="sticky top-24 hidden xl:block">
            <nav aria-label="On this page" className="max-w-xs">
              <h2 className="mb-4 text-sm font-medium">On this page</h2>
              <ul className="space-y-3 border-l border-border pl-4 text-sm leading-relaxed text-muted-foreground">
                {article.data.toc.map((item) => (
                  <li
                    key={item.url}
                    className={item.depth > 2 ? 'pl-3' : undefined}
                  >
                    <a href={item.url} className="hover:text-foreground">
                      {item.title}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
