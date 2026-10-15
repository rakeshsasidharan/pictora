import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { SiteFooter } from '../components/site_footer';
import { SiteHeader } from '../components/site_header';
import { sessionFromHeaders } from '../lib/session';
import './globals.css';

export const metadata: Metadata = {
  title: 'Pictora',
  description:
    'Turn text prompts into images, from watercolour to photorealism. Free, with a daily allowance.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = sessionFromHeaders(await headers());
  return (
    <html lang="en">
      <body>
        <SiteHeader session={session} />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
