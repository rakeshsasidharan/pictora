import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as login } from '../src/app/auth/login/route';
import { POST as logout } from '../src/app/auth/logout/route';
import { decodeLoginState } from '../src/lib/auth_cookies';
import { codeChallenge } from '../src/lib/pkce';
import { CLIENT_ID, SITE_URL, TEST_CONFIG, USER_POOL_ID } from './auth_helpers';

beforeEach(() => {
  vi.stubEnv('COGNITO_USER_POOL_ID', USER_POOL_ID);
  vi.stubEnv('COGNITO_DOMAIN', TEST_CONFIG.cognitoDomain);
  vi.stubEnv('COGNITO_CLIENT_ID', CLIENT_ID);
  vi.stubEnv('SITE_URL', SITE_URL);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function loginCookie(response: Response): string {
  const header = response.headers.getSetCookie().find((c) => c.startsWith('pictora_login=')) ?? '';
  return header;
}

describe('GET /auth/login', () => {
  it('redirects to Cognito with PKCE and remembers state and verifier in an httpOnly cookie', async () => {
    const response = await login(new NextRequest(`${SITE_URL}/auth/login?returnTo=/gallery`));

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(
      `${TEST_CONFIG.cognitoDomain}/oauth2/authorize`,
    );
    const params = Object.fromEntries(location.searchParams);
    expect(params).toMatchObject({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: `${SITE_URL}/auth/callback`,
      scope: 'openid email profile',
      code_challenge_method: 'S256',
    });
    expect(params.identity_provider).toBeUndefined();

    const header = loginCookie(response);
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/Secure/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).toMatch(/Path=\/auth/);
    const value = header.slice('pictora_login='.length, header.indexOf(';'));
    const state = decodeLoginState(value);
    expect(state).toMatchObject({ state: params.state, returnTo: '/gallery' });
    expect(codeChallenge(state?.codeVerifier ?? '')).toBe(params.code_challenge);
  });

  it('uses a fresh state and verifier every time', async () => {
    const first = await login(new NextRequest(`${SITE_URL}/auth/login`));
    const second = await login(new NextRequest(`${SITE_URL}/auth/login`));
    expect(loginCookie(first)).not.toBe(loginCookie(second));
  });

  it('goes straight to Google with ?provider=google', async () => {
    const response = await login(new NextRequest(`${SITE_URL}/auth/login?provider=google`));
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.searchParams.get('identity_provider')).toBe('Google');
  });

  it('never returns to another site', async () => {
    const response = await login(
      new NextRequest(`${SITE_URL}/auth/login?returnTo=https://evil.example`),
    );
    const header = loginCookie(response);
    const value = header.slice('pictora_login='.length, header.indexOf(';'));
    expect(decodeLoginState(value)?.returnTo).toBe('/');
  });

  it('answers 503 when sign-in is not configured', async () => {
    vi.stubEnv('COGNITO_USER_POOL_ID', '');
    expect((await login(new NextRequest(`${SITE_URL}/auth/login`))).status).toBe(503);
  });
});

describe('POST /auth/logout', () => {
  it('clears the session cookies and calls Cognito logout', async () => {
    const response = await logout();
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(`${TEST_CONFIG.cognitoDomain}/logout`);
    expect(Object.fromEntries(location.searchParams)).toEqual({
      client_id: CLIENT_ID,
      logout_uri: `${SITE_URL}/`,
    });
    const cookies = response.headers.getSetCookie();
    for (const name of ['pictora_access', 'pictora_id', 'pictora_refresh']) {
      expect(cookies.find((c) => c.startsWith(`${name}=`))).toMatch(/Max-Age=0/);
    }
  });
});
