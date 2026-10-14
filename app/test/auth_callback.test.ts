import { describe, expect, it } from 'vitest';
import { handleCallback } from '../src/lib/auth_callback';
import { encodeLoginState, LOGIN_COOKIE } from '../src/lib/auth_cookies';
import {
  accessToken,
  idToken,
  localVerifier,
  siteRequest,
  SITE_URL,
  TEST_CONFIG,
  tokenEndpoint,
} from './auth_helpers';

const LOGIN = { state: 'expected-state', codeVerifier: 'the-code-verifier', returnTo: '/gallery' };

function callback(query: string, login: typeof LOGIN | null = LOGIN) {
  return siteRequest(`/auth/callback?${query}`, {
    cookies: login ? { [LOGIN_COOKIE]: encodeLoginState(login) } : {},
  });
}

const goodTokens = () => ({
  access_token: accessToken(),
  id_token: idToken(),
  refresh_token: 'refresh-token',
  expires_in: 3600,
});

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

describe('handleCallback', () => {
  it('exchanges the code with the PKCE verifier, sets the session cookies and returns to the page', async () => {
    const fetchFn = tokenEndpoint(200, goodTokens());
    const response = await handleCallback(callback('code=abc&state=expected-state'), {
      config: TEST_CONFIG,
      verifier: localVerifier(),
      fetchFn,
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${SITE_URL}/gallery`);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe(`${TEST_CONFIG.cognitoDomain}/oauth2/token`);
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      grant_type: 'authorization_code',
      code: 'abc',
      code_verifier: 'the-code-verifier',
      redirect_uri: `${SITE_URL}/auth/callback`,
      client_id: TEST_CONFIG.clientId,
    });
    const cookies = setCookies(response).join('\n');
    expect(cookies).toMatch(/pictora_access=ey/);
    expect(cookies).toMatch(/pictora_id=ey/);
    expect(cookies).toMatch(/pictora_refresh=refresh-token/);
    expect(cookies).toMatch(/pictora_login=;/);
  });

  it('rejects a state that does not match the login cookie, without calling Cognito', async () => {
    const fetchFn = tokenEndpoint(200, goodTokens());
    const response = await handleCallback(callback('code=abc&state=forged-state'), {
      config: TEST_CONFIG,
      verifier: localVerifier(),
      fetchFn,
    });
    expect(response.status).toBe(400);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(setCookies(response).join('\n')).not.toMatch(/pictora_access=ey/);
  });

  it('rejects a callback without the login cookie or without a state', async () => {
    const deps = {
      config: TEST_CONFIG,
      verifier: localVerifier(),
      fetchFn: tokenEndpoint(200, {}),
    };
    expect(
      (await handleCallback(callback('code=abc&state=expected-state', null), deps)).status,
    ).toBe(400);
    expect((await handleCallback(callback('code=abc'), deps)).status).toBe(400);
    expect(deps.fetchFn).not.toHaveBeenCalled();
  });

  it('rejects a code that Cognito refuses because the PKCE verifier does not match', async () => {
    const response = await handleCallback(callback('code=abc&state=expected-state'), {
      config: TEST_CONFIG,
      verifier: localVerifier(),
      fetchFn: tokenEndpoint(400, { error: 'invalid_grant' }),
    });
    expect(response.status).toBe(400);
    expect(setCookies(response).join('\n')).not.toMatch(/pictora_access=ey/);
  });

  it('rejects tokens that fail verification', async () => {
    const response = await handleCallback(callback('code=abc&state=expected-state'), {
      config: TEST_CONFIG,
      verifier: localVerifier(),
      fetchFn: tokenEndpoint(200, {
        ...goodTokens(),
        access_token: accessToken({ wrongKey: true }),
      }),
    });
    expect(response.status).toBe(400);
  });

  it('goes home when the user cancelled at Cognito', async () => {
    const fetchFn = tokenEndpoint(200, goodTokens());
    const response = await handleCallback(callback('error=access_denied&state=expected-state'), {
      config: TEST_CONFIG,
      verifier: localVerifier(),
      fetchFn,
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${SITE_URL}/`);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('answers 503 when sign-in is not configured', async () => {
    expect((await handleCallback(callback('code=abc&state=expected-state'), {})).status).toBe(503);
  });
});
