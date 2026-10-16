import type { Metadata } from 'next';
import { site } from './site';

export const socialImage = {
  url: '/og.png',
  width: 1200,
  height: 630,
  type: 'image/png',
  alt: 'valve: Many workers. One rate limit. Three workers share one outbound API budget.',
};

/** Match canonical URLs to the static export's trailing-slash routes. */
export function siteUrl(path: string) {
  return new URL(path.endsWith('/') ? path : `${path}/`, site.url).href;
}

export function pageMetadata({
  title,
  description = site.description,
  path,
  absoluteTitle = false,
}: {
  title: string;
  description?: string;
  path: string;
  absoluteTitle?: boolean;
}): Metadata {
  const socialTitle = absoluteTitle ? title : `${title} | ${site.name}`;
  return {
    title: absoluteTitle ? { absolute: title } : title,
    description,
    alternates: { canonical: siteUrl(path) },
    openGraph: {
      type: 'website',
      locale: 'en_US',
      siteName: site.name,
      title: socialTitle,
      description,
      url: siteUrl(path),
      images: [socialImage],
    },
    twitter: {
      card: 'summary_large_image',
      title: socialTitle,
      description,
      images: [socialImage],
    },
  };
}
