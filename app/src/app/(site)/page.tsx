import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { LandingPage } from '../../components/landing_page';
import { signedInHome } from '../../lib/onboarding';
import { sessionFromHeaders } from '../../lib/session';

/**
 * Signed-out visitors see the landing page (AUTH-2), with the private beta notice after a sign-up the allowlist
 * refused (`?signin=private_beta`). Signed-in users go to onboarding until they have accepted the current terms
 * (AUTH-4), then straight to the generate screen.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = sessionFromHeaders(await headers());
  if (session) redirect(await signedInHome(session));
  const { signin } = await searchParams;
  return <LandingPage betaRejected={signin === 'private_beta'} />;
}
