import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

/** Secrets are cached for 5 minutes (tech design 10). */
export const SECRET_CACHE_MS = 5 * 60_000;

export interface SecretApiKeyOptions {
  client?: Pick<SecretsManagerClient, 'send'>;
  cacheMs?: number;
  now?: () => number;
}

/**
 * Reads an API key from a Secrets Manager secret, cached for 5 minutes. The secret holds the key as plain
 * text, or as JSON with an `apiKey` field.
 */
export function secretApiKey(
  secretId: string,
  options: SecretApiKeyOptions = {},
): () => Promise<string> {
  const read = secretString(secretId, options);
  return async () => apiKeyFromSecret(await read());
}

/** Reads a Secrets Manager secret's text as stored, cached for 5 minutes. Throws when it is empty. */
export function secretString(
  secretId: string,
  options: SecretApiKeyOptions = {},
): () => Promise<string> {
  const { cacheMs = SECRET_CACHE_MS, now = Date.now } = options;
  let client = options.client;
  let cached: { value: string; until: number } | undefined;

  return async () => {
    if (cached && now() < cached.until) return cached.value;
    client ??= new SecretsManagerClient({});
    const result = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    const value = result.SecretString?.trim();
    if (!value) throw new Error('The secret is empty');
    cached = { value, until: now() + cacheMs };
    return value;
  };
}

export function apiKeyFromSecret(secret: string | undefined): string {
  const text = secret?.trim();
  if (!text) throw new Error('The secret is empty');
  if (text.startsWith('{')) {
    const parsed = JSON.parse(text) as { apiKey?: unknown };
    if (typeof parsed.apiKey !== 'string' || !parsed.apiKey.trim()) {
      throw new Error('The secret has no apiKey');
    }
    return parsed.apiKey.trim();
  }
  return text;
}
