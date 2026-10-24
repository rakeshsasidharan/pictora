import { TOS_VERSION } from '@pictora/core';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { OnboardingForm } from '../../../components/onboarding_form';
import { documentClient, tableName } from '../../../lib/dynamodb';
import { LEGAL_PAGES } from '../../../lib/legal_pages';
import { ensureProfile, onboardingComplete } from '../../../lib/profile';
import { sessionFromHeaders } from '../../../lib/session';
import { GENERATE_PATH } from '../../../lib/site';

export const metadata: Metadata = { title: 'Welcome · Pictora' };
export const dynamic = 'force-dynamic';

/** Onboarding (AUTH-4): confirm age and accept the terms and content policy before the first image. */
export default async function OnboardingPage() {
  const session = sessionFromHeaders(await headers());
  // The proxy sends signed-out visitors to sign in before they get here.
  if (!session) redirect('/');
  const profile = await ensureProfile(documentClient(), tableName(), session, new Date());
  if (onboardingComplete(profile)) redirect(GENERATE_PATH);

  const termsChanged = profile.tosAcceptedAt !== undefined;
  return (
    <main className="onboarding">
      <h1>{termsChanged ? 'Our terms have changed' : 'Welcome to Pictora'}</h1>
      <p>
        {termsChanged
          ? 'Please read and accept the updated terms to keep creating images.'
          : 'Before your first image, please confirm your age and accept our terms.'}
      </p>
      <OnboardingForm
        tosVersion={TOS_VERSION}
        documents={LEGAL_PAGES.filter((page) => page.acceptedAtOnboarding).map((page) => ({
          title: page.title,
          path: page.path,
        }))}
      />
    </main>
  );
}
