import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, expect, it } from 'vitest';
import { SECRET_CACHE_MS, apiKeyFromSecret, secretApiKey } from '../src/secrets.js';

describe('secretApiKey', () => {
  it('reads the secret once and caches it for 5 minutes', async () => {
    const sm = mockClient(SecretsManagerClient);
    sm.on(GetSecretValueCommand, { SecretId: 'pictora/dev/openai' }).resolves({
      SecretString: 'sk-one',
    });
    let time = 0;
    const read = secretApiKey('pictora/dev/openai', {
      client: new SecretsManagerClient({}),
      now: () => time,
    });
    expect(await read()).toBe('sk-one');
    time = SECRET_CACHE_MS - 1;
    expect(await read()).toBe('sk-one');
    expect(sm.commandCalls(GetSecretValueCommand)).toHaveLength(1);
    sm.on(GetSecretValueCommand).resolves({ SecretString: 'sk-two' });
    time = SECRET_CACHE_MS;
    expect(await read()).toBe('sk-two');
    expect(sm.commandCalls(GetSecretValueCommand)).toHaveLength(2);
    sm.restore();
  });
});

describe('apiKeyFromSecret', () => {
  it('takes plain text or JSON with an apiKey', () => {
    expect(apiKeyFromSecret(' sk-plain \n')).toBe('sk-plain');
    expect(apiKeyFromSecret('{"apiKey":"sk-json"}')).toBe('sk-json');
    expect(() => apiKeyFromSecret('')).toThrow(/empty/);
    expect(() => apiKeyFromSecret(undefined)).toThrow(/empty/);
    expect(() => apiKeyFromSecret('{"key":"x"}')).toThrow(/no apiKey/);
  });
});
