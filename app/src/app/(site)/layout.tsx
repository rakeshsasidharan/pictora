import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { SiteFooter } from '../../components/site_footer';
import { SiteHeader } from '../../components/site_header';
import { sessionFromHeaders } from '../../lib/session';

/** The public pages (landing, legal pages, onboarding): the site header, the page, and the footer. */
export default async function SiteLayout({ children }: { children: ReactNode }) {
  const session = sessionFromHeaders(await headers());
  return (
    <>
      <SiteHeader session={session} />
      {children}
      <SiteFooter />
    </>
  );
}
