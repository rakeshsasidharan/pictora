import { describe, expect, it } from 'vitest';
import { authenticate } from '../src/lib/auth_proxy';
import { SESSION_HEADERS } from '../src/lib/session';
import {
  accessToken,
  EMAIL,
  idToken,
  localVerifier,
  siteRequest,
  SITE_URL,
  SUB,
  TEST_CONFIG,
  tokenEndpoint,
} from './auth_helpers';

const verifier = localVerifier();

function deps(fetchFn = tokenEndpoint(500, {})) {
  return { config: TEST_CONFIG, verifier, nodeEnv: 'production', fetchFn };
}

function session(options: Parameters<typeof accessToken>[0] = {}) {
  return { pictora_access: accessToken(options), pictora_id: idToken(options) };
}

/** The request header Next.js passes on to the route handler. */
function forwardedHeader(response: Response, name: string): string | null {
  return response.headers.get(`x-middleware-request-${name}`);
}

function setCookies(response: Response): string {
  return response.headers.getSetCookie().join('\n');
}

describe('authenticate: API routes', () => {
  it('answers 401 without a session', async () => {
    const response = await authenticate(siteRequest('/api/me'), deps());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('answers 401 for a token signed by another key, and clears the cookies', async () => {
    const response = await authenticate(
      siteRequest('/api/me', { cookies: session({ wrongKey: true }) }),
      deps(),
    );
    expect(response.status).toBe(401);
    expect(setCookies(response)).toMatch(/pictora_access=;.*Max-Age=0/);
  });

  it('answers 401 for a malformed token', async () => {
    const response = await authenticate(
      siteRequest('/api/me', { cookies: { pictora_access: 'not.a.jwt', pictora_id: 'nope' } }),
      deps(),
    );
    expect(response.status).toBe(401);
  });

  it('passes a valid session on to the route as headers', async () => {
    const response = await authenticate(
      siteRequest('/api/me', { cookies: session({ groups: ['admins'] }) }),
      deps(),
    );
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(forwardedHeader(response, SESSION_HEADERS.sub)).toBe(SUB);
    expect(forwardedHeader(response, SESSION_HEADERS.email)).toBe(EMAIL);
    expect(forwardedHeader(response, SESSION_HEADERS.groups)).toBe('admins');
    expect(forwardedHeader(response, SESSION_HEADERS.username)).toBe(SUB);
  });

  it('drops session headers sent by the browser', async () => {
    const response = await authenticate(
      siteRequest('/api/me', { headers: { [SESSION_HEADERS.sub]: 'someone-else' } }),
      deps(),
    );
    expect(response.status).toBe(401);

    const health = await authenticate(
      siteRequest('/api/health', { headers: { [SESSION_HEADERS.sub]: 'someone-else' } }),
      deps(),
    );
    expect(forwardedHeader(health, SESSION_HEADERS.sub)).toBeNull();
  });

  it('leaves /api/health public', async () => {
    const response = await authenticate(siteRequest('/api/health'), deps());
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
});

describe('authenticate: refresh', () => {
  const refreshed = {
    access_token: accessToken(),
    id_token: idToken(),
    expires_in: 3600,
    token_type: 'Bearer',
  };

  it('refreshes an expired access token and stores the new tokens', async () => {
    const fetchFn = tokenEndpoint(200, refreshed);
    const response = await authenticate(
      siteRequest('/api/me', {
        cookies: { ...session({ expiresIn: -60 }), pictora_refresh: 'the-refresh-token' },
      }),
      deps(fetchFn),
    );

    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(forwardedHeader(response, SESSION_HEADERS.sub)).toBe(SUB);
    const body = new URLSearchParams(String(fetchFn.mock.calls[0]?.[1]?.body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('the-refresh-token');
    expect(setCookies(response)).toContain(`pictora_access=${refreshed.access_token}`);
    expect(setCookies(response)).toContain(`pictora_id=${refreshed.id_token}`);
    // Cognito returns no new refresh token, so the existing cookie stays.
    expect(setCookies(response)).not.toContain('pictora_refresh=');
  });

  it('refreshes when the access cookie has already expired in the browser', async () => {
    const fetchFn = tokenEndpoint(200, refreshed);
    const response = await authenticate(
      siteRequest('/api/me', { cookies: { pictora_refresh: 'the-refresh-token' } }),
      deps(fetchFn),
    );
    expect(forwardedHeader(response, SESSION_HEADERS.sub)).toBe(SUB);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('signs the user out when the refresh token is refused', async () => {
    const response = await authenticate(
      siteRequest('/api/me', {
        cookies: { ...session({ expiresIn: -60 }), pictora_refresh: 'revoked' },
      }),
      deps(tokenEndpoint(400, { error: 'invalid_grant' })),
    );
    expect(response.status).toBe(401);
    expect(setCookies(response)).toMatch(/pictora_refresh=;.*Max-Age=0/);
  });

  it('answers 401 for an expired token with no refresh token', async () => {
    const fetchFn = tokenEndpoint(200, refreshed);
    const response = await authenticate(
      siteRequest('/api/me', { cookies: session({ expiresIn: -60 }) }),
      deps(fetchFn),
    );
    expect(response.status).toBe(401);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('authenticate: pages', () => {
  it('redirects a visitor on a protected page to sign in, then back', async () => {
    const response = await authenticate(siteRequest('/gallery?page=2'), deps());
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(`${SITE_URL}/auth/login`);
    expect(location.searchParams.get('returnTo')).toBe('/gallery?page=2');
  });

  it('lets a signed-in user on a protected page', async () => {
    const response = await authenticate(siteRequest('/gallery', { cookies: session() }), deps());
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('shows public pages to visitors, and identifies a signed-in user there', async () => {
    const visitor = await authenticate(siteRequest('/'), deps());
    expect(visitor.headers.get('x-middleware-next')).toBe('1');
    expect(forwardedHeader(visitor, SESSION_HEADERS.sub)).toBeNull();

    const user = await authenticate(siteRequest('/', { cookies: session() }), deps());
    expect(forwardedHeader(user, SESSION_HEADERS.email)).toBe(EMAIL);
  });
});

describe('authenticate: CSRF', () => {
  it('refuses a state-changing request from another origin', async () => {
    const response = await authenticate(
      siteRequest('/api/me', {
        method: 'POST',
        cookies: session(),
        headers: { origin: 'https://evil.example' },
      }),
      deps(),
    );
    expect(response.status).toBe(403);
  });

  it('refuses a state-changing request without an Origin, including sign-out', async () => {
    const response = await authenticate(siteRequest('/auth/logout', { method: 'POST' }), deps());
    expect(response.status).toBe(403);
  });

  it('accepts a state-changing request from the site', async () => {
    const response = await authenticate(
      siteRequest('/auth/logout', { method: 'POST', headers: { origin: SITE_URL } }),
      deps(),
    );
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('refuses state-changing requests when sign-in is not configured, except in local development', async () => {
    const request = () =>
      siteRequest('/auth/logout', { method: 'POST', headers: { origin: SITE_URL } });
    expect((await authenticate(request(), { nodeEnv: 'production' })).status).toBe(403);
    const local = await authenticate(request(), { nodeEnv: 'development' });
    expect(local.headers.get('x-middleware-next')).toBe('1');
  });
});
