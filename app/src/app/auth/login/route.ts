import { NextResponse, type NextRequest } from 'next/server';
import { authConfig } from '../../../lib/auth_config';
import {
  cookieOptions,
  encodeLoginState,
  LOGIN_COOKIE,
  LOGIN_COOKIE_MAX_AGE,
  safeReturnTo,
} from '../../../lib/auth_cookies';
import { authorizeUrl } from '../../../lib/cognito_oauth';
import { codeChallenge, randomToken } from '../../../lib/pkce';

export const dynamic = 'force-dynamic';

/** Identity providers that can be picked with `?provider=`, skipping Cognito's own page. */
const PROVIDERS: Record<string, string> = { google: 'Google' };

/**
 * Starts sign-in (tech design 8): remembers a fresh `state` and PKCE verifier in a short-lived `httpOnly`
 * cookie and redirects to Cognito's managed login. `?returnTo=` is where to land afterwards.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const config = await authConfig();
  if (!config) {
    return NextResponse.json({ error: 'Sign-in is not configured' }, { status: 503 });
  }
  const { searchParams } = request.nextUrl;
  const state = randomToken();
  const codeVerifier = randomToken(48);
  const provider = searchParams.get('provider');

  const response = NextResponse.redirect(
    authorizeUrl(config, {
      state,
      codeChallenge: codeChallenge(codeVerifier),
      identityProvider: provider ? PROVIDERS[provider] : undefined,
    }),
    302,
  );
  response.cookies.set(
    LOGIN_COOKIE,
    encodeLoginState({ state, codeVerifier, returnTo: safeReturnTo(searchParams.get('returnTo')) }),
    cookieOptions(LOGIN_COOKIE_MAX_AGE, '/auth'),
  );
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
