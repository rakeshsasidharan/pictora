import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { LandingPage } from '../components/landing_page';
import { sessionFromHeaders } from '../lib/session';
import { GENERATE_PATH } from '../lib/site';

/** Signed-out visitors see the landing page (AUTH-2); signed-in users go straight to the generate screen. */
export default async function HomePage() {
  const session = sessionFromHeaders(await headers());
  if (session) redirect(GENERATE_PATH);
  return <LandingPage />;
}
