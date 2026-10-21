import Link from 'next/link';
import { ADMIN_PATH, isAdmin } from '../lib/admin_access';
import { LOGIN_PATH, LOGOUT_PATH } from '../lib/cognito_oauth';
import type { Session } from '../lib/session';
import { ACCOUNT_PATH, GALLERY_PATH, GENERATE_PATH } from '../lib/site';

/**
 * The top bar: for a signed-in user, links to create an image and to their gallery, an Admin link for admins,
 * their email linking to their account, and a sign-out button; otherwise a sign-in link.
 */
export function SiteHeader({ session }: { session?: Session }) {
  return (
    <header className="site-header">
      <Link href="/" className="site-name">
        Pictora
      </Link>
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
    </header>
  );
}
