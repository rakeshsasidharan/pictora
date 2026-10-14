import { NextResponse, type NextRequest } from 'next/server';
import type { AuthConfig } from './auth_config';
import { cookieOptions, decodeLoginState, LOGIN_COOKIE, setSessionCookies } from './auth_cookies';
import { exchangeCode, type FetchFn } from './cognito_oauth';
import { constantTimeEqual } from './pkce';
import type { TokenVerifier } from './token_verifier';

/** Collaborators the callback uses; tests pass their own. */
export interface CallbackDeps {
  config?: AuthConfig;
  verifier?: TokenVerifier;
  fetchFn?: FetchFn;
}

/**
 * Checks `state` against the login cookie, exchanges the code on the server with the PKCE verifier, verifies
 * the tokens and stores them in `httpOnly` cookies. A missing or mismatched `state`, or a code the token
 * endpoint refuses (for example a wrong PKCE verifier), is rejected with 400.
 */
export async function handleCallback(request: NextRequest, deps: CallbackDeps): Promise<Response> {
  const { config, verifier } = deps;
  if (!config || !verifier) {
    return NextResponse.json({ error: 'Sign-in is not configured' }, { status: 503 });
  }
  const { searchParams } = request.nextUrl;
  const login = decodeLoginState(request.cookies.get(LOGIN_COOKIE)?.value);
  const state = searchParams.get('state');
  const code = searchParams.get('code');

  if (!login || !state || !constantTimeEqual(state, login.state)) {
    return failed('Sign-in failed: the request did not match. Try signing in again.');
  }
  // The user cancelled, or Cognito refused the sign-in.
  if (searchParams.get('error') || !code) {
    return withLoginCookieCleared(NextResponse.redirect(`${config.siteUrl}/`, 302));
  }

  try {
    const tokens = await exchangeCode(
      config,
      { code, codeVerifier: login.codeVerifier },
      deps.fetchFn,
    );
    const result = await verifier.verify(tokens);
    if (result.status !== 'valid') {
      return failed('Sign-in failed: the tokens could not be verified. Try signing in again.');
    }
    const response = NextResponse.redirect(`${config.siteUrl}${login.returnTo}`, 302);
    setSessionCookies(response, tokens);
    return withLoginCookieCleared(response);
  } catch {
    return failed('Sign-in failed: the sign-in code was refused. Try signing in again.');
  }
}

function failed(message: string): NextResponse {
  return withLoginCookieCleared(NextResponse.json({ error: message }, { status: 400 }));
}

function withLoginCookieCleared(response: NextResponse): NextResponse {
  response.cookies.set(LOGIN_COOKIE, '', cookieOptions(0, '/auth'));
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
