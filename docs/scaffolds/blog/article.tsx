import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { blogSource } from '@/lib/source';
import { getMDXComponents } from '@/mdx-components';
import '@/scaffolds/blog/blog.css';

type Props = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return blogSource.getPages().map((page) => ({ slug: page.slugs[0] }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = blogSource.getPage([(await params).slug]);
  if (!page) notFound();
  return { title: page.data.title, description: page.data.description };
}

export default async function ArticlePage({ params }: Props) {
  const page = blogSource.getPage([(await params).slug]);
  if (!page) notFound();
  const Content = page.data.body;
  return (
    <article className="article-page">
      <Link href="/blog" className="back-link">
        Back to blog
      </Link>
      <header className="page-intro">
        <h1>{page.data.title}</h1>
        <p>{page.data.description}</p>
      </header>
      <div className="prose article-body">
        <Content components={getMDXComponents()} />
      </div>
      <footer className="article-next">
        <Link href="/docs" className="text-link">
          Documentation
        </Link>
        <Link href="/changelog" className="text-link">
          Package changelog
        </Link>
      </footer>
    </article>
  );
}
