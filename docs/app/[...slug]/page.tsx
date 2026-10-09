import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { source } from '@/lib/source';
import { LegacyDocRedirect } from '@/components/legacy-doc-redirect';

type Props = { params: Promise<{ slug: string[] }> };

export const metadata: Metadata = {
  title: 'Documentation has moved',
  robots: { index: false, follow: true },
};

export function generateStaticParams() {
  return source.generateParams().filter(({ slug }) => slug && slug.length > 0);
}

export default async function LegacyPage({ params }: Props) {
  const page = source.getPage((await params).slug);
  if (!page) notFound();
  return <LegacyDocRedirect url={page.url} />;
}
