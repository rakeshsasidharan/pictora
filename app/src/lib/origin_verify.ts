import { timingSafeEqual } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

/** Header CloudFront adds to every request it forwards to the Function URL (tech design 3.1). */
export const ORIGIN_VERIFY_HEADER = 'x-origin-verify';

/** Secrets are cached for 5 minutes (tech design 10). */
export const SECRET_CACHE_MS = 5 * 60 * 1000;

export type OriginVerifyResult = 'allowed' | 'forbidden';

/** Where the expected header value comes from. */
export interface OriginVerifyOptions {
  /** `process.env.NODE_ENV`; the check is skipped in local development. */
  nodeEnv?: string;
  /** Returns the expected header value, or undefined when none is configured. */
  expectedValue: () => Promise<string | undefined>;
}

/**
 * Decides whether a request came through CloudFront: it must carry the secret `X-Origin-Verify` value.
 * Fails closed: with no expected value configured, every request is forbidden outside development.
 */
export async function verifyOrigin(
  headerValue: string | null,
  options: OriginVerifyOptions,
): Promise<OriginVerifyResult> {
  if (options.nodeEnv === 'development') return 'allowed';
  if (!headerValue) return 'forbidden';
  const expected = await options.expectedValue();
  if (!expected) return 'forbidden';
  return constantTimeEqual(headerValue, expected) ? 'allowed' : 'forbidden';
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The environment variables `expectedOriginSecret` reads. */
export interface OriginSecretEnv {
  [name: string]: string | undefined;
  ORIGIN_VERIFY_SECRET?: string;
  ORIGIN_VERIFY_SECRET_ARN?: string;
}

let client: SecretsManagerClient | undefined;
let cached: { value: string; expiresAt: number } | undefined;

/**
 * The expected header value: `ORIGIN_VERIFY_SECRET` when set (local production builds), otherwise the
 * Secrets Manager secret named by `ORIGIN_VERIFY_SECRET_ARN`, cached for 5 minutes.
 */
export async function expectedOriginSecret(
  env: OriginSecretEnv = process.env,
  now: number = Date.now(),
): Promise<string | undefined> {
  if (env.ORIGIN_VERIFY_SECRET) return env.ORIGIN_VERIFY_SECRET;
  const secretId = env.ORIGIN_VERIFY_SECRET_ARN;
  if (!secretId) return undefined;
  if (cached && cached.expiresAt > now) return cached.value;

  client ??= new SecretsManagerClient({});
  const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!SecretString) throw new Error(`Secret ${secretId} has no string value`);
  cached = { value: SecretString, expiresAt: now + SECRET_CACHE_MS };
  return SecretString;
}

/** Clears the cached secret and client; for tests. */
export function resetOriginSecretCache(): void {
  cached = undefined;
  client = undefined;
}
