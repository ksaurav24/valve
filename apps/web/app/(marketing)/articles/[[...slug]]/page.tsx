import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ArticleIndex } from '@/components/articles/article-index';
import { ArticleDetail } from '@/components/articles/article-detail';
import { getArticles } from '@/lib/articles';
import { pageMetadata } from '@/lib/metadata';

type Props = { params: Promise<{ slug?: string[] }> };

export const dynamicParams = false;

export function generateStaticParams() {
  // Include the index so an empty collection still exports without fake articles.
  return [{ slug: [] }, ...getArticles().map((page) => ({ slug: page.slugs }))];
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug = [] } = await params;
  if (slug.length === 0) {
    return pageMetadata({
      title: 'Articles',
      description:
        'Notes on rate limiting, distributed systems, and building valve.',
      path: '/articles',
    });
  }

  const article = getArticles().find(
    (page) => page.slugs.join('/') === slug.join('/'),
  );
  if (!article) notFound();
  const metadata = pageMetadata({
    title: article.data.title,
    description: article.data.description,
    path: article.url,
  });
  return {
    ...metadata,
    ...(article.data.author
      ? { authors: [{ name: article.data.author }] }
      : {}),
    openGraph: {
      ...metadata.openGraph,
      type: 'article',
      publishedTime: article.data.date,
      ...(article.data.author ? { authors: [article.data.author] } : {}),
    },
  };
}

export default async function ArticlesPage({ params }: Props) {
  const { slug = [] } = await params;
  const articles = getArticles();
  if (slug.length === 0) return <ArticleIndex articles={articles} />;

  const article = articles.find(
    (page) => page.slugs.join('/') === slug.join('/'),
  );
  if (!article) notFound();
  return <ArticleDetail article={article} />;
}
