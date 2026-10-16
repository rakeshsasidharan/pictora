import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { LandingPage } from '../components/landing_page';
import { signedInHome } from '../lib/onboarding';
import { sessionFromHeaders } from '../lib/session';

/**
 * Signed-out visitors see the landing page (AUTH-2). Signed-in users go to onboarding until they have accepted
 * the current terms (AUTH-4), then straight to the generate screen.
 */
export default async function HomePage() {
  const session = sessionFromHeaders(await headers());
  if (session) redirect(await signedInHome(session));
  return <LandingPage />;
}
