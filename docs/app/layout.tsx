import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { RootProvider } from 'fumadocs-ui/provider/next';
import '@fontsource-variable/manrope';
import '@fontsource-variable/jetbrains-mono';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'valve documentation', template: '%s | valve' },
  description:
    'One rate limit for every worker that calls an API. Guides and reference for valve.',
  icons: { icon: '/favicon.svg' },
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
