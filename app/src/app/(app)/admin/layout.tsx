import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ADMIN_PATH, isAdmin } from '../../../lib/admin_access';
import { sessionFromHeaders } from '../../../lib/session';

export const metadata: Metadata = { title: 'Admin · Pictora' };
export const dynamic = 'force-dynamic';

const ADMIN_LINKS = [
  { href: ADMIN_PATH, label: 'Dashboard' },
  { href: `${ADMIN_PATH}/moderation`, label: 'Moderation review' },
  { href: `${ADMIN_PATH}/users`, label: 'Users' },
];

/**
 * The admin area (ADM-3, ADM-4), for the Cognito `admins` group. The proxy already answers 403 to anyone else;
 * this checks again, so the pages never render for a non-admin.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = sessionFromHeaders(await headers());
  // The proxy sends signed-out visitors to sign in before they get here.
  if (!session) redirect('/');
  if (!isAdmin(session)) {
    return (
      <div data-slot="admin-page" className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">Forbidden</h1>
        <p className="text-muted-foreground">Only admins can see this page.</p>
      </div>
    );
  }
  return (
    <div data-slot="admin-page" className="flex min-w-0 flex-col gap-6">
      <nav aria-label="Admin" className="flex flex-wrap gap-1 border-b pb-3">
        {ADMIN_LINKS.map((link) => (
          <Button key={link.href} asChild variant="ghost" size="sm">
            <Link href={link.href}>{link.label}</Link>
          </Button>
        ))}
      </nav>
      {children}
    </div>
  );
}
