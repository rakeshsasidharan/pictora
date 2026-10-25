import Link from 'next/link';
import { ADMIN_PATH, isAdmin } from '../lib/admin_access';
import { LOGIN_PATH, LOGOUT_PATH } from '../lib/cognito_oauth';
import type { Session } from '../lib/session';
import { ACCOUNT_PATH, GALLERY_PATH, GENERATE_PATH } from '../lib/site';
import { PictoraIcon } from './pictora_icon';
import { ThemeSwitcher } from './theme_switcher';

/**
 * The top bar of the public pages (landing, legal pages, onboarding); signed-in pages have the sidebar instead.
 * For a signed-in user, links to create an image and to their gallery, an Admin link for admins, their email
 * linking to their account, and a sign-out button; otherwise a sign-in link. The theme switcher sits at the end
 * until the landing restyle moves it (#111).
 */
export function SiteHeader({ session }: { session?: Session }) {
  return (
    <header className="site-header">
      <Link
        href="/"
        className="flex items-center gap-2 text-base font-semibold text-foreground no-underline"
      >
        <PictoraIcon className="size-8" />
        Pictora
      </Link>
      <div className="flex items-center gap-3">
        {session ? (
          <div className="site-account">
            <Link href={GENERATE_PATH}>Create</Link>
            <Link href={GALLERY_PATH}>Gallery</Link>
            {isAdmin(session) && <Link href={ADMIN_PATH}>Admin</Link>}
            <Link href={ACCOUNT_PATH}>{session.email}</Link>
            <form method="post" action={LOGOUT_PATH}>
              <button type="submit">Sign out</button>
            </form>
          </div>
        ) : (
          // A route handler, not a page, so a plain link rather than a prefetching <Link>.
          <a href={LOGIN_PATH}>Sign in</a>
        )}
        <ThemeSwitcher />
      </div>
    </header>
  );
}
