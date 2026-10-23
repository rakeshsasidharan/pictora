import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { LandingMarker } from '../components/landing_marker';
import { SiteFooter } from '../components/site_footer';
import { SiteHeader } from '../components/site_header';
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
  const session = sessionFromHeaders(await headers());
  return (
    <html lang="en">
      <body>
        <SiteHeader session={session} />
        {children}
        <SiteFooter />
        <LandingMarker />
      </body>
    </html>
  );
}
