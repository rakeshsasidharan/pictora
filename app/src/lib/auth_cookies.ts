import type { NextResponse } from 'next/server';
import type { TokenSet } from './cognito_oauth';

/** Session cookies. They are `httpOnly`, so tokens never reach client-side JavaScript. */
export const ACCESS_COOKIE = 'pictora_access';
export const ID_COOKIE = 'pictora_id';
export const REFRESH_COOKIE = 'pictora_refresh';
/** Holds the `state`, PKCE verifier and return path between `/auth/login` and `/auth/callback`. */
export const LOGIN_COOKIE = 'pictora_login';

/** The refresh token lasts 30 days (tech design 8); the login cookie only as long as a sign-in. */
export const REFRESH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
export const LOGIN_COOKIE_MAX_AGE = 10 * 60;

export const SESSION_COOKIES = [ACCESS_COOKIE, ID_COOKIE, REFRESH_COOKIE] as const;

export interface CookieOptions {
  httpOnly: true;
  secure: true;
  sameSite: 'lax';
  path: string;
  maxAge: number;
}

/** `httpOnly`, `Secure`, `SameSite=Lax` cookie attributes (tech design 8). */
export function cookieOptions(maxAge: number, path = '/'): CookieOptions {
  return { httpOnly: true, secure: true, sameSite: 'lax', path, maxAge };
}

/** Stores the tokens. The access and ID cookies expire with their tokens; the refresh cookie lasts 30 days. */
export function setSessionCookies(response: NextResponse, tokens: TokenSet): void {
  response.cookies.set(ACCESS_COOKIE, tokens.accessToken, cookieOptions(tokens.expiresIn));
  response.cookies.set(ID_COOKIE, tokens.idToken, cookieOptions(tokens.expiresIn));
  if (tokens.refreshToken) {
    response.cookies.set(
      REFRESH_COOKIE,
      tokens.refreshToken,
      cookieOptions(REFRESH_COOKIE_MAX_AGE),
    );
  }
}

export function clearSessionCookies(response: NextResponse): void {
  for (const name of SESSION_COOKIES) {
    response.cookies.set(name, '', cookieOptions(0));
  }
}

/** What `/auth/login` remembers for `/auth/callback`. */
export interface LoginState {
  state: string;
  codeVerifier: string;
  returnTo: string;
}

export function encodeLoginState(login: LoginState): string {
  return Buffer.from(JSON.stringify(login)).toString('base64url');
}

/** Parses the login cookie, or returns undefined when it is missing or malformed. */
export function decodeLoginState(value: string | undefined): LoginState | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { state, codeVerifier, returnTo } = parsed as Record<string, unknown>;
    if (typeof state !== 'string' || typeof codeVerifier !== 'string') return undefined;
    return { state, codeVerifier, returnTo: safeReturnTo(returnTo) };
  } catch {
    return undefined;
  }
}

/** A same-site path to return to after sign-in; anything else becomes `/`, so it can't be an open redirect. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/')) return '/';
  if (value.startsWith('//') || value.startsWith('/\\') || value.startsWith('/auth/')) return '/';
  return value;
}
