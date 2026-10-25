import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '../../components/app_shell';
import { SiteFooter } from '../../components/site_footer';
import { isAdmin } from '../../lib/admin_access';
import { sessionFromHeaders } from '../../lib/session';
import { SIDEBAR_STATE_COOKIE } from '../../lib/site';

/**
 * The signed-in pages (generate, edit, gallery, image detail, account and admin) inside the sidebar shell. The
 * sidebar starts collapsed to icons, and opens as the user last left it after that, which shadcn's provider keeps
 * in a cookie.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = sessionFromHeaders(await headers());
  // The proxy sends signed-out visitors to sign in before they get here.
  if (!session) redirect('/');
  const sidebarState = (await cookies()).get(SIDEBAR_STATE_COOKIE)?.value;
  return (
    <AppShell
      email={session.email}
      admin={isAdmin(session)}
      defaultOpen={sidebarState === 'true'}
      footer={<SiteFooter />}
    >
      {children}
    </AppShell>
  );
}
