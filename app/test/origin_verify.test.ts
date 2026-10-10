import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  expectedOriginSecret,
  resetOriginSecretCache,
  SECRET_CACHE_MS,
  verifyOrigin,
} from '../src/lib/origin_verify';
import { proxy } from '../src/proxy';

const SECRET = 'correct-horse-battery-staple';

const send = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    send = send;
  },
  GetSecretValueCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://example.lambda-url.us-west-2.on.aws/api/health', { headers });
}

afterEach(() => {
  vi.unstubAllEnvs();
  send.mockReset();
  resetOriginSecretCache();
});

describe('verifyOrigin', () => {
  const options = { nodeEnv: 'production', expectedValue: async () => SECRET };

  it('forbids a request without the header', async () => {
    expect(await verifyOrigin(null, options)).toBe('forbidden');
  });

  it('forbids a request with the wrong header value', async () => {
    expect(await verifyOrigin('wrong', options)).toBe('forbidden');
    expect(await verifyOrigin(`${SECRET}x`, options)).toBe('forbidden');
  });

  it('allows a request with the correct header value', async () => {
    expect(await verifyOrigin(SECRET, options)).toBe('allowed');
  });

  it('fails closed when no expected value is configured', async () => {
    expect(
      await verifyOrigin('anything', { ...options, expectedValue: async () => undefined }),
    ).toBe('forbidden');
  });

  it('allows everything in local development', async () => {
    expect(await verifyOrigin(null, { ...options, nodeEnv: 'development' })).toBe('allowed');
  });
});

describe('expectedOriginSecret', () => {
  it('prefers ORIGIN_VERIFY_SECRET over Secrets Manager', async () => {
    expect(
      await expectedOriginSecret({ ORIGIN_VERIFY_SECRET: SECRET, ORIGIN_VERIFY_SECRET_ARN: 'arn' }),
    ).toBe(SECRET);
    expect(send).not.toHaveBeenCalled();
  });

  it('returns undefined when nothing is configured', async () => {
    expect(await expectedOriginSecret({})).toBeUndefined();
  });

  it('reads the secret once and caches it for 5 minutes', async () => {
    send.mockResolvedValue({ SecretString: SECRET });
    const env = { ORIGIN_VERIFY_SECRET_ARN: 'arn:secret' };

    expect(await expectedOriginSecret(env, 0)).toBe(SECRET);
    expect(await expectedOriginSecret(env, SECRET_CACHE_MS - 1)).toBe(SECRET);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ input: { SecretId: 'arn:secret' } });

    expect(await expectedOriginSecret(env, SECRET_CACHE_MS)).toBe(SECRET);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('proxy', () => {
  it('returns 403 when the header is missing', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ORIGIN_VERIFY_SECRET', SECRET);
    const response = await proxy(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden' });
  });

  it('returns 403 when the header is wrong', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ORIGIN_VERIFY_SECRET', SECRET);
    const response = await proxy(request({ 'X-Origin-Verify': 'wrong' }));
    expect(response.status).toBe(403);
  });

  it('passes the request on when the header is correct', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ORIGIN_VERIFY_SECRET', SECRET);
    const response = await proxy(request({ 'X-Origin-Verify': SECRET }));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('passes every request on in local development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const response = await proxy(request());
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
});
