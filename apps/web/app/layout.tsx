import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { MotionProvider } from '@/components/shared/providers';
import { site } from '@/lib/site';
import { pageMetadata } from '@/lib/metadata';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './globals.css';

export const metadata: Metadata = {
  ...pageMetadata({ title: site.title, path: '/', absoluteTitle: true }),
  metadataBase: new URL(site.url),
  applicationName: site.name,
  title: { default: site.title, template: '%s | valve' },
  authors: [{ name: 'Saurav K.', url: 'https://github.com/ksaurav24' }],
  creator: 'Saurav K.',
  category: 'developer tools',
  keywords: [
    'TypeScript',
    'rate limiting',
    'outbound APIs',
    'Redis',
    'Valkey',
    'distributed rate limiter',
  ],
  manifest: '/manifest.webmanifest',
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large' },
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#080808' },
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider
          theme={{ defaultTheme: 'dark', enableSystem: false }}
          search={{ options: { type: 'static', api: '/api/search' } }}
        >
          <MotionProvider>{children}</MotionProvider>
        </RootProvider>
      </body>
    </html>
  );
}
