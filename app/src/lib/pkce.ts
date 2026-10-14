import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** A random URL-safe string, used for the OAuth `state` and the PKCE code verifier. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** The S256 code challenge for a PKCE code verifier (RFC 7636). */
export function codeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

/** Compares two strings in constant time, so the `state` check leaks nothing through timing. */
export function constantTimeEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
