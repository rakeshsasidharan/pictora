import { redirect } from 'next/navigation';
import { documentClient, tableName } from './dynamodb';
import { onboardingComplete, readProfile } from './profile';
import type { Session } from './session';
import { GENERATE_PATH, ONBOARDING_PATH } from './site';

/** Reads the profile, so tests can stand in for DynamoDB. */
export type ProfileReader = typeof readProfile;

/** True when the user still has to confirm their age or accept the current terms (AUTH-4). */
export async function needsOnboarding(
  session: Session,
  read: ProfileReader = readProfile,
): Promise<boolean> {
  const profile = await read(documentClient(), tableName(), session.sub);
  return !profile || !onboardingComplete(profile);
}

/** Where a signed-in user starts: onboarding until it is done for the current terms, then the generate screen. */
export async function signedInHome(
  session: Session,
  read: ProfileReader = readProfile,
): Promise<string> {
  return (await needsOnboarding(session, read)) ? ONBOARDING_PATH : GENERATE_PATH;
}

/** For pages that create or show images: sends users who haven't been through onboarding there first. */
export async function requireOnboarding(
  session: Session,
  read: ProfileReader = readProfile,
): Promise<void> {
  if (await needsOnboarding(session, read)) redirect(ONBOARDING_PATH);
}
