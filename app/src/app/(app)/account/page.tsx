import type { GenerateDefaults } from '@pictora/core';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AccountDetails } from '../../../components/account_details';
import { generateCatalog } from '../../../lib/generate_catalog';
import { getDefaults, type DefaultsDeps } from '../../../lib/generate_defaults';
import { documentClient, tableName } from '../../../lib/dynamodb';
import { getMe, type MeBody } from '../../../lib/jobs';
import { jobsDeps } from '../../../lib/jobs_deps';
import { sessionFromHeaders, signInMethod } from '../../../lib/session';

export const metadata: Metadata = { title: 'Account · Pictora' };
export const dynamic = 'force-dynamic';

/**
 * Account settings (AUTH-3, GEN-11): email, sign-in method, member-since date, today's points, the user's generate
 * defaults with the models they can pick, and deletion.
 */
export default async function AccountPage() {
  const session = sessionFromHeaders(await headers());
  // The proxy sends signed-out visitors to sign in before they get here.
  if (!session) redirect('/');
  const deps = jobsDeps();
  const defaultsDeps: DefaultsDeps = {
    client: documentClient(),
    tableName: tableName(),
    now: () => new Date(),
  };
  const [me, { models, styles }, defaults] = await Promise.all([
    getMe(deps, session).then((result) => result.body as unknown as MeBody),
    generateCatalog(deps, session),
    getDefaults(defaultsDeps, session).then(
      (result) => result.body as { defaults: GenerateDefaults; saved: boolean },
    ),
  ]);
  return (
    <AccountDetails
      me={me}
      method={signInMethod(session)}
      generateDefaults={{ models, styles, ...defaults }}
    />
  );
}
