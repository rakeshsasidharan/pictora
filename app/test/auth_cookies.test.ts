import { NextResponse } from 'next/server';
import { describe, expect, it } from 'vitest';
import {
  clearSessionCookies,
  cookieOptions,
  decodeLoginState,
  encodeLoginState,
  safeReturnTo,
  setSessionCookies,
} from '../src/lib/auth_cookies';

function setCookieHeaders(response: NextResponse): Map<string, string> {
  return new Map(
    response.headers.getSetCookie().map((header) => [header.slice(0, header.indexOf('=')), header]),
  );
}

describe('session cookies', () => {
  it('are httpOnly, Secure and SameSite=Lax on the whole site', () => {
    expect(cookieOptions(60)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60,
    });

    const response = NextResponse.next();
    setSessionCookies(response, {
      accessToken: 'access',
      idToken: 'id',
      refreshToken: 'refresh',
      expiresIn: 3600,
    });
    const cookies = setCookieHeaders(response);
    for (const name of ['pictora_access', 'pictora_id', 'pictora_refresh']) {
      const header = cookies.get(name) ?? '';
      expect(header).toMatch(/; HttpOnly/i);
      expect(header).toMatch(/; Secure/i);
      expect(header).toMatch(/; SameSite=Lax/i);
      expect(header).toMatch(/; Path=\//);
    }
    expect(cookies.get('pictora_access')).toMatch(/Max-Age=3600/);
    expect(cookies.get('pictora_id')).toMatch(/Max-Age=3600/);
    expect(cookies.get('pictora_refresh')).toMatch(/Max-Age=2592000/);
  });

  it('keeps the refresh cookie when a refresh returns no new refresh token', () => {
    const response = NextResponse.next();
    setSessionCookies(response, { accessToken: 'a', idToken: 'i', expiresIn: 3600 });
    expect(setCookieHeaders(response).has('pictora_refresh')).toBe(false);
  });

  it('are cleared by expiring them', () => {
    const response = NextResponse.next();
    clearSessionCookies(response);
    const cookies = setCookieHeaders(response);
    expect([...cookies.keys()].sort()).toEqual(['pictora_access', 'pictora_id', 'pictora_refresh']);
    for (const header of cookies.values()) expect(header).toMatch(/Max-Age=0/);
  });
});

describe('login state', () => {
  it('round-trips through the cookie value', () => {
    const login = { state: 's', codeVerifier: 'v', returnTo: '/gallery?page=2' };
    expect(decodeLoginState(encodeLoginState(login))).toEqual(login);
  });

  it('is undefined when missing or malformed', () => {
    expect(decodeLoginState(undefined)).toBeUndefined();
    expect(decodeLoginState('not base64 json')).toBeUndefined();
    expect(decodeLoginState(Buffer.from('{"state":1}').toString('base64url'))).toBeUndefined();
  });
});

describe('safeReturnTo', () => {
  it.each([
    ['/gallery', '/gallery'],
    ['/images/1?v=2', '/images/1?v=2'],
    ['https://evil.example', '/'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['/auth/logout', '/'],
    [null, '/'],
  ])('maps %s to %s', (input, expected) => {
    expect(safeReturnTo(input)).toBe(expected);
  });
});
