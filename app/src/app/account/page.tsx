import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AccountDetails } from '../../components/account_details';
import { getMe, type MeBody } from '../../lib/jobs';
import { jobsDeps } from '../../lib/jobs_deps';
import { sessionFromHeaders, signInMethod } from '../../lib/session';

export const metadata: Metadata = { title: 'Account · Pictora' };
export const dynamic = 'force-dynamic';

/** Account settings (AUTH-3): email, sign-in method, member-since date, today's points, and deletion. */
export default async function AccountPage() {
  const session = sessionFromHeaders(await headers());
  // The proxy sends signed-out visitors to sign in before they get here.
  if (!session) redirect('/');
  const me = (await getMe(jobsDeps(), session)).body as unknown as MeBody;
  return <AccountDetails me={me} method={signInMethod(session)} />;
}
