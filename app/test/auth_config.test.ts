import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTH_CONFIG_CACHE_MS, authConfig, resetAuthConfigCache } from '../src/lib/auth_config';

const send = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    send = send;
  },
  GetParameterCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

const BASE = {
  COGNITO_USER_POOL_ID: 'us-west-2_Pool',
  COGNITO_DOMAIN: 'https://pictora-dev.auth.us-west-2.amazoncognito.com/',
};

afterEach(() => {
  send.mockReset();
  resetAuthConfigCache();
});

describe('authConfig', () => {
  it('is undefined when the user pool is not configured', async () => {
    expect(await authConfig({})).toBeUndefined();
    expect(await authConfig({ COGNITO_USER_POOL_ID: 'p' })).toBeUndefined();
    expect(await authConfig(BASE)).toBeUndefined();
  });

  it('takes the client ID and site URL from the environment for local development', async () => {
    expect(
      await authConfig({
        ...BASE,
        COGNITO_CLIENT_ID: 'client',
        SITE_URL: 'http://localhost:3000/',
      }),
    ).toEqual({
      userPoolId: 'us-west-2_Pool',
      clientId: 'client',
      cognitoDomain: 'https://pictora-dev.auth.us-west-2.amazoncognito.com',
      siteUrl: 'http://localhost:3000',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('reads them from the SSM parameter when deployed, cached for 5 minutes', async () => {
    send.mockResolvedValue({
      Parameter: {
        Value: JSON.stringify({ siteUrl: 'https://d123.cloudfront.net', cognitoClientId: 'abc' }),
      },
    });
    const env = { ...BASE, APP_CONFIG_PARAMETER: '/pictora/prod/app-config' };

    expect(await authConfig(env, 0)).toMatchObject({
      clientId: 'abc',
      siteUrl: 'https://d123.cloudfront.net',
    });
    await authConfig(env, AUTH_CONFIG_CACHE_MS - 1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ input: { Name: '/pictora/prod/app-config' } });

    await authConfig(env, AUTH_CONFIG_CACHE_MS);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('fails clearly on a malformed parameter', async () => {
    send.mockResolvedValue({ Parameter: { Value: '{"siteUrl":"x"}' } });
    await expect(authConfig({ ...BASE, APP_CONFIG_PARAMETER: '/p' })).rejects.toThrow(
      /cognitoClientId/,
    );
  });
});
