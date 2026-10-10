import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { MotionProvider } from '@/components/shared/providers';
import { site } from '@/lib/site';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'valve', template: '%s | valve' },
  description: site.description,
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
