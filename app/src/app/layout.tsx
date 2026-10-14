import type { Metadata } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { SiteHeader } from '../components/site_header';
import { sessionFromHeaders } from '../lib/session';

export const metadata: Metadata = {
  title: 'Pictora',
  description: 'Turn text prompts into images.',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = sessionFromHeaders(await headers());
  return (
    <html lang="en">
      <body>
        <SiteHeader session={session} />
        {children}
      </body>
    </html>
  );
}
