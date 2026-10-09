import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { RootProvider } from 'fumadocs-ui/provider/next';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'valve', template: '%s | valve' },
  description:
    'A shared rate limit for outbound API calls across every worker, with provider-aware backoff.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider
          theme={{ defaultTheme: 'system' }}
          search={{ options: { type: 'static', api: '/api/search' } }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
