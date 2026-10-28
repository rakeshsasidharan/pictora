import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ADMIN_PATH, isAdmin } from '../lib/admin_access';
import { LOGIN_PATH, LOGOUT_PATH } from '../lib/cognito_oauth';
import type { Session } from '../lib/session';
import { ACCOUNT_PATH, GALLERY_PATH, GENERATE_PATH } from '../lib/site';
import { PictoraIcon } from './pictora_icon';
import { ThemeSwitcher } from './theme_switcher';

/**
 * The top bar of the public pages (landing, legal pages, onboarding); signed-in pages have the sidebar instead.
 * Visitors get a Sign in button. A signed-in user reading a legal page or onboarding gets links to create an
 * image and to their gallery, an Admin link for admins, their email linking to their account, and a sign-out
 * button. The theme switcher is last.
 */
export function SiteHeader({ session }: { session?: Session }) {
  return (
    <header
      data-slot="site-header"
      className="sticky top-0 z-10 flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b bg-background/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80"
    >
      <Link
        href="/"
        className="flex items-center gap-2 text-base font-semibold text-foreground no-underline"
      >
        <PictoraIcon className="size-8" />
        Pictora
      </Link>
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
        {session ? (
          <>
            <Button asChild variant="ghost" size="sm">
              <Link href={GENERATE_PATH}>Create</Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href={GALLERY_PATH}>Gallery</Link>
            </Button>
            {isAdmin(session) && (
              <Button asChild variant="ghost" size="sm">
                <Link href={ADMIN_PATH}>Admin</Link>
              </Button>
            )}
            <Button asChild variant="ghost" size="sm" className="max-w-56 min-w-0">
              <Link href={ACCOUNT_PATH}>
                <span className="truncate">{session.email}</span>
              </Link>
            </Button>
            <form method="post" action={LOGOUT_PATH}>
              <Button type="submit" variant="outline" size="sm">
                Sign out
              </Button>
            </form>
          </>
        ) : (
          <Button asChild size="sm">
            {/* A route handler, not a page, so a plain link rather than a prefetching <Link>. */}
            <a href={LOGIN_PATH}>Sign in</a>
          </Button>
        )}
        <ThemeSwitcher />
      </div>
    </header>
  );
}
