import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { SiteFooter } from '../components/site_footer';
import { SiteHeader } from '../components/site_header';
import { ThemeProvider } from '../components/theme_provider';
import { Toaster } from '../components/ui/sonner';
import { sessionFromHeaders } from '../lib/session';
import { SITE_DESCRIPTION } from '../lib/site';
import './globals.css';

// The favicon, icon and Apple touch icon come from the favicon.ico, icon.png and apple-icon.png files next to
// this layout, and the manifest from manifest.ts; app/scripts/generate_icons.mjs makes the images.
export const metadata: Metadata = {
  title: 'Pictora',
  description: SITE_DESCRIPTION,
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const requestHeaders = await headers();
  const session = sessionFromHeaders(requestHeaders);
  // next-themes changes the class on <html> before React hydrates, which is expected.
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider nonce={requestHeaders.get('x-nonce') ?? undefined}>
          <SiteHeader session={session} />
          {children}
          <SiteFooter />
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
