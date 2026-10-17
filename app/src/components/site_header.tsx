import Link from 'next/link';
import { LOGIN_PATH, LOGOUT_PATH } from '../lib/cognito_oauth';
import type { Session } from '../lib/session';
import { ACCOUNT_PATH } from '../lib/site';

/** The top bar: the signed-in user's email, linking to their account, and a sign-out button; or a sign-in link. */
export function SiteHeader({ session }: { session?: Session }) {
  return (
    <header className="site-header">
      <Link href="/" className="site-name">
        Pictora
      </Link>
      {session ? (
        <div className="site-account">
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
