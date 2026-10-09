import type { Metadata } from 'next';
import Link from 'next/link';
import { blogSource } from '@/lib/source';
import '@/scaffolds/blog/blog.css';

export const metadata: Metadata = {
  title: 'Blog',
  description:
    'Release announcements, library updates, and API decisions for valve.',
};

export default function BlogPage() {
  return (
    <div className="editorial-page">
      <header className="page-intro">
        <h1>Library updates</h1>
        <p>Release announcements, API changes, and notes on the library.</p>
      </header>
      <div className="article-list">
        {blogSource.getPages().map((page) => (
          <article key={page.url}>
            <h2>
              <Link href={page.url}>{page.data.title}</Link>
            </h2>
            <p>{page.data.description}</p>
            <Link href={page.url} className="text-link">
              Read article<span className="sr-only">: {page.data.title}</span>
            </Link>
          </article>
        ))}
      </div>
    </div>
  );
}
