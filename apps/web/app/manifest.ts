import type { MetadataRoute } from 'next';
import { site } from '@/lib/site';

export const dynamic = 'force-static';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: site.name,
    short_name: site.name,
    description: site.description,
    lang: 'en',
    start_url: '/',
    scope: '/',
    display: 'browser',
    background_color: '#080808',
    theme_color: '#080808',
    icons: [192, 512].map((size) => ({
      src: `/icons/valve-${size}.png`,
      sizes: `${size}x${size}`,
      type: 'image/png',
      purpose: 'any',
    })),
  };
}
