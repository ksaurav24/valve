import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/metadata';
import { source } from '@/lib/source';

export const dynamic = 'force-static';

export default function sitemap(): MetadataRoute.Sitemap {
  const paths = [
    '/',
    '/changelog',
    '/releases',
    '/contributors',
    ...source.getPages().map((page) => page.url),
  ];
  return [...new Set(paths.map(siteUrl))].map((url) => ({ url }));
}
