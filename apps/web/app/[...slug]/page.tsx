import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { source } from '@/lib/source';
import { LegacyDocRedirect } from '@/components/shared/legacy-doc-redirect';
import { pageMetadata } from '@/lib/metadata';

type Props = { params: Promise<{ slug: string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = source.getPage((await params).slug);
  if (!page) notFound();
  return {
    ...pageMetadata({
      title: 'Documentation has moved',
      description: page.data.description,
      path: page.url,
    }),
    robots: { index: false, follow: true },
  };
}

export function generateStaticParams() {
  return source.generateParams().filter(({ slug }) => slug && slug.length > 0);
}

export default async function LegacyPage({ params }: Props) {
  const page = source.getPage((await params).slug);
  if (!page) notFound();
  return <LegacyDocRedirect url={page.url} />;
}
