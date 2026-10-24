import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { ADMIN_PATH, isAdmin } from '../../../lib/admin_access';
import { sessionFromHeaders } from '../../../lib/session';

export const metadata: Metadata = { title: 'Admin · Pictora' };
export const dynamic = 'force-dynamic';

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
      <div className="admin">
        <h1>Forbidden</h1>
        <p>Only admins can see this page.</p>
      </div>
    );
  }
  return (
    <div className="admin">
      <nav className="admin-nav" aria-label="Admin">
        <Link href={ADMIN_PATH}>Dashboard</Link>
        <Link href={`${ADMIN_PATH}/moderation`}>Moderation review</Link>
        <Link href={`${ADMIN_PATH}/users`}>Users</Link>
      </nav>
      {children}
    </div>
  );
}
