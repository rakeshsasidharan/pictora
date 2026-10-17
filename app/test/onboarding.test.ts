import { TOS_VERSION } from '@pictora/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  needsOnboarding,
  requireOnboarding,
  signedInHome,
  type ProfileReader,
} from '../src/lib/onboarding';
import type { Profile } from '../src/lib/profile';
import { SESSION_HEADERS, sessionFromHeaders, signInMethod } from '../src/lib/session';

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`redirect to ${url}`), { url });
  },
}));

const session = { sub: 'abc', email: 'user@example.com', groups: [] };
const profile = (fields: Partial<Profile> = {}): Profile => ({
  sub: 'abc',
  createdAt: '2026-10-01T00:00:00.000Z',
  status: 'active',
  activeJobs: 0,
  ...fields,
});
const reader =
  (found: Profile | undefined): ProfileReader =>
  async () =>
    found;
const done = { tosAcceptedAt: '2026-10-14T00:00:00Z', tosVersion: TOS_VERSION, ageConfirmed: true };

describe('onboarding redirects', () => {
  beforeEach(() => {
    vi.stubEnv('TABLE_NAME', 'pictora-test');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sends users without a profile, or without accepting the current terms, to onboarding', async () => {
    expect(await signedInHome(session, reader(undefined))).toBe('/onboarding');
    expect(await signedInHome(session, reader(profile()))).toBe('/onboarding');
    expect(await signedInHome(session, reader(profile({ ...done, tosVersion: 'old' })))).toBe(
      '/onboarding',
    );
    expect(await signedInHome(session, reader(profile({ ...done, ageConfirmed: false })))).toBe(
      '/onboarding',
    );
  });

  it('sends onboarded users to the generate screen', async () => {
    expect(await signedInHome(session, reader(profile(done)))).toBe('/generate');
    expect(await needsOnboarding(session, reader(profile(done)))).toBe(false);
  });

  it('redirects from pages that need onboarding', async () => {
    await expect(requireOnboarding(session, reader(profile()))).rejects.toMatchObject({
      url: '/onboarding',
    });
    await expect(requireOnboarding(session, reader(profile(done)))).resolves.toBeUndefined();
  });
});

describe('session', () => {
  it('reads the username header', () => {
    expect(
      sessionFromHeaders(
        new Headers({ [SESSION_HEADERS.sub]: 'abc', [SESSION_HEADERS.username]: 'google_1' }),
      ),
    ).toEqual({ sub: 'abc', email: '', groups: [], username: 'google_1' });
    expect(sessionFromHeaders(new Headers({ [SESSION_HEADERS.sub]: 'abc' }))).not.toHaveProperty(
      'username',
    );
  });

  it('names the sign-in method from the username', () => {
    expect(signInMethod({ username: 'google_1234' })).toBe('Google');
    expect(signInMethod({ username: 'Google_1234' })).toBe('Google');
    expect(signInMethod({ username: 'abc-123' })).toBe('Email and password');
    expect(signInMethod({})).toBe('Email and password');
  });
});
