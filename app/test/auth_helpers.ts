import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { Jwks } from 'aws-jwt-verify/jwk';
import { NextRequest } from 'next/server';
import { vi } from 'vitest';
import type { AuthConfig } from '../src/lib/auth_config';
import type { FetchFn } from '../src/lib/cognito_oauth';
import { createTokenVerifier, type TokenVerifier } from '../src/lib/token_verifier';

export const USER_POOL_ID = 'us-west-2_TestPool1';
export const CLIENT_ID = 'test-client-id';
export const ISSUER = `https://cognito-idp.us-west-2.amazonaws.com/${USER_POOL_ID}`;
export const SITE_URL = 'https://pictora.example.dev';
export const SUB = '8f1b5a2e-1111-4c4c-9d9d-123456789abc';
export const EMAIL = 'user@example.com';

export const TEST_CONFIG: AuthConfig = {
  userPoolId: USER_POOL_ID,
  clientId: CLIENT_ID,
  cognitoDomain: 'https://pictora-test.auth.us-west-2.amazoncognito.com',
  siteUrl: SITE_URL,
};

const KID = 'test-key-1';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });

/** A JWKS with the test signing key, standing in for Cognito's. */
export const LOCAL_JWKS = {
  keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }],
} as unknown as Jwks;

/** A verifier for the test pool that uses the local JWKS and never calls Cognito. */
export function localVerifier(): TokenVerifier {
  const verifier = createTokenVerifier(TEST_CONFIG);
  verifier.cacheJwks(LOCAL_JWKS);
  return verifier;
}

function sign(payload: Record<string, unknown>, privateKey: KeyObject = keys.privateKey): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', kid: KID, typ: 'JWT' })}.${encode(payload)}`;
  const signature = createSign('RSA-SHA256')
    .update(unsigned)
    .sign(privateKey)
    .toString('base64url');
  return `${unsigned}.${signature}`;
}

export interface TokenOptions {
  /** Seconds from now until expiry; negative for an expired token. */
  expiresIn?: number;
  sub?: string;
  groups?: string[];
  /** Signs with a key that isn't in the JWKS. */
  wrongKey?: boolean;
}

function times(expiresIn: number) {
  const now = Math.floor(Date.now() / 1000);
  return { iat: now - 60, auth_time: now - 60, exp: now + expiresIn };
}

export function accessToken(options: TokenOptions = {}): string {
  return sign(
    {
      sub: options.sub ?? SUB,
      iss: ISSUER,
      client_id: CLIENT_ID,
      token_use: 'access',
      scope: 'openid email profile',
      username: options.sub ?? SUB,
      ...(options.groups ? { 'cognito:groups': options.groups } : {}),
      ...times(options.expiresIn ?? 3600),
    },
    options.wrongKey ? otherKeys.privateKey : undefined,
  );
}

export function idToken(options: TokenOptions = {}): string {
  return sign(
    {
      sub: options.sub ?? SUB,
      iss: ISSUER,
      aud: CLIENT_ID,
      token_use: 'id',
      email: EMAIL,
      email_verified: true,
      ...times(options.expiresIn ?? 3600),
    },
    options.wrongKey ? otherKeys.privateKey : undefined,
  );
}

/** A request to the site with optional cookies and headers. */
export function siteRequest(
  path: string,
  options: {
    method?: string;
    cookies?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
): NextRequest {
  const headers = new Headers(options.headers);
  if (options.cookies) {
    headers.set(
      'cookie',
      Object.entries(options.cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join('; '),
    );
  }
  return new NextRequest(`${SITE_URL}${path}`, { method: options.method ?? 'GET', headers });
}

/** A fetch stub answering the Cognito token endpoint. */
export function tokenEndpoint(status: number, body: Record<string, unknown>) {
  return vi.fn<FetchFn>(async () => Response.json(body, { status }));
}
