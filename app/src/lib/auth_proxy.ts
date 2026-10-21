import { NextResponse, type NextRequest } from 'next/server';
import { isAdmin, isAdminPath } from './admin_access';
import type { AuthConfig } from './auth_config';
import {
  ACCESS_COOKIE,
  clearSessionCookies,
  ID_COOKIE,
  REFRESH_COOKIE,
  setSessionCookies,
} from './auth_cookies';
import { LOGIN_PATH, refreshTokens, type FetchFn, type TokenSet } from './cognito_oauth';
import { originAllowed } from './csrf';
import { deleteSessionHeaders, setSessionHeaders, type Session } from './session';
import type { TokenVerifier } from './token_verifier';

/** Public API routes: no session needed (tech design 7). */
export const PUBLIC_API_PATHS = ['/api/health'];

/** Pages that need a signed-in user; visitors are sent to sign in and brought back. */
export const PROTECTED_PAGE_PREFIXES = [
  '/generate',
  '/edit',
  '/gallery',
  '/images',
  '/admin',
  '/onboarding',
  '/account',
];

export interface AuthProxyDeps {
  /** Undefined when sign-in isn't configured: nobody is signed in and state-changing requests are refused. */
  config?: AuthConfig;
  verifier?: TokenVerifier;
  /** `process.env.NODE_ENV`; local development accepts state-changing requests without a site URL. */
  nodeEnv?: string;
  fetchFn?: FetchFn;
}

type Access = 'public' | 'api' | 'page';

function accessFor(pathname: string): Access {
  if (pathname.startsWith('/api/')) {
    return PUBLIC_API_PATHS.includes(pathname) ? 'public' : 'api';
  }
  const protectedPage = PROTECTED_PAGE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  return protectedPage ? 'page' : 'public';
}

/** Paths where the proxy doesn't look at the session at all: the sign-in flow and build assets. */
function skipsSession(pathname: string): boolean {
  return (
    pathname.startsWith('/auth/') ||
    pathname.startsWith('/_next/') ||
    PUBLIC_API_PATHS.includes(pathname)
  );
}

/**
 * Authenticates a request (tech design 8). It checks the `Origin` of state-changing requests, verifies the
 * access token from the cookies and, when it has expired, refreshes it with the refresh token, so users are
 * not signed out after an hour. The verified user goes to route handlers as request headers. `/api/*` routes
 * other than `/api/health` answer 401 without a session; protected pages redirect to sign in. `/admin` pages and
 * `/api/admin/*` answer 403 to anyone outside the `admins` group.
 */
export async function authenticate(
  request: NextRequest,
  deps: AuthProxyDeps,
): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;
  const siteUrl = deps.config?.siteUrl;

  if (
    !originAllowed(request.method, request.headers.get('origin'), siteUrl) &&
    !(deps.nodeEnv === 'development' && !siteUrl)
  ) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const requestHeaders = new Headers(request.headers);
  deleteSessionHeaders(requestHeaders);
  if (skipsSession(pathname)) {
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  const outcome = await resolveSession(request, deps);
  const access = accessFor(pathname);
  let response: NextResponse;
  if (outcome.session && isAdminPath(pathname) && !isAdmin(outcome.session)) {
    // ADM-1 to ADM-5: only the admins group may use the admin pages and APIs.
    response =
      access === 'api'
        ? NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        : new NextResponse('Forbidden', {
            status: 403,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
  } else if (outcome.session) {
    setSessionHeaders(requestHeaders, outcome.session);
    response = NextResponse.next({ request: { headers: requestHeaders } });
  } else if (access === 'api') {
    response = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  } else if (access === 'page' && siteUrl) {
    const login = new URL(LOGIN_PATH, siteUrl);
    login.searchParams.set('returnTo', `${pathname}${search}`);
    response = NextResponse.redirect(login, 302);
  } else {
    response = NextResponse.next({ request: { headers: requestHeaders } });
  }

  if (outcome.refreshed) setSessionCookies(response, outcome.refreshed);
  if (outcome.clearCookies) clearSessionCookies(response);
  return response;
}

interface SessionOutcome {
  session?: Session;
  /** New tokens to store, after a refresh. */
  refreshed?: TokenSet;
  /** The cookies hold tokens that can't be used, so the browser should drop them. */
  clearCookies?: boolean;
}

async function resolveSession(request: NextRequest, deps: AuthProxyDeps): Promise<SessionOutcome> {
  const { config, verifier } = deps;
  const accessToken = request.cookies.get(ACCESS_COOKIE)?.value;
  const idToken = request.cookies.get(ID_COOKIE)?.value;
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;
  if (!accessToken && !idToken && !refreshToken) return {};
  if (!config || !verifier) return { clearCookies: true };

  if (accessToken && idToken) {
    const result = await verifier.verify({ accessToken, idToken });
    if (result.status === 'valid') return { session: result.session };
    if (result.status === 'invalid') return { clearCookies: true };
  }
  // The access token expired, or its cookie did (it lasts as long as the token).
  if (!refreshToken) return { clearCookies: true };
  try {
    const tokens = await refreshTokens(config, refreshToken, deps.fetchFn);
    const result = await verifier.verify(tokens);
    if (result.status !== 'valid') return { clearCookies: true };
    return { session: result.session, refreshed: tokens };
  } catch {
    // A revoked or expired refresh token: the user has to sign in again.
    return { clearCookies: true };
  }
}
