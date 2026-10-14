import { App } from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_HOSTED_ZONE_ID,
  PLACEHOLDER_IMAGE_DIGEST,
  stageConfig,
} from '../lib/stage_config.js';
import { cdkJsonContext, TEST_IMAGE_DIGEST } from './helpers.js';

const WORKER_DIGEST = `sha256:${'b'.repeat(64)}`;

const devSettings = {
  domain: 'pictora.rpillai.dev',
  authDomainPrefix: 'pictora-test-dev',
  dailyPoints: 1000,
  spendCapUsd: 20,
  queueConcurrency: 5,
  budgetUsd: 15,
};

function configFor(context: Record<string, unknown>, envName: 'dev' | 'prod' = 'dev') {
  return stageConfig(new App({ context }).node, envName);
}

describe('stageConfig', () => {
  it('uses placeholders so synth works without deploy-time context', () => {
    const config = configFor(cdkJsonContext());
    expect(config.hostedZoneId).toBe(PLACEHOLDER_HOSTED_ZONE_ID);
    expect(config.appImageDigest).toBe(PLACEHOLDER_IMAGE_DIGEST);
    expect(config.placeholderImage).toBe(true);
    expect(config.workerImageDigest).toBe(PLACEHOLDER_IMAGE_DIGEST);
    expect(config.gitSha).toBe('local');
    expect(config.alertEmail).toBeUndefined();
  });

  it('takes deploy-time values from context', () => {
    const config = configFor({
      environments: { dev: devSettings },
      hostedZoneId: 'ZREALZONE',
      appImageDigest: TEST_IMAGE_DIGEST,
      workerImageDigest: WORKER_DIGEST,
      appStaticDir: '.',
      gitSha: 'abc123',
      alertEmail: 'alerts@example.com',
    });
    expect(config).toMatchObject({
      hostedZoneId: 'ZREALZONE',
      appImageDigest: TEST_IMAGE_DIGEST,
      placeholderImage: false,
      workerImageDigest: WORKER_DIGEST,
      gitSha: 'abc123',
      alertEmail: 'alerts@example.com',
    });
  });

  it('treats empty context values as unset', () => {
    const config = configFor({
      environments: { dev: devSettings },
      hostedZoneId: '',
      alertEmail: '',
      workerImageDigest: '',
    });
    expect(config.hostedZoneId).toBe(PLACEHOLDER_HOSTED_ZONE_ID);
    expect(config.workerImageDigest).toBe(PLACEHOLDER_IMAGE_DIGEST);
    expect(config.alertEmail).toBeUndefined();
  });

  it.each(['appImageDigest', 'workerImageDigest'])('rejects a malformed %s', (key) => {
    expect(() => configFor({ environments: { dev: devSettings }, [key]: 'latest' })).toThrow(key);
  });

  it('refuses a real image without its static files', () => {
    expect(() =>
      configFor({
        environments: { dev: devSettings },
        appImageDigest: TEST_IMAGE_DIGEST,
        appStaticDir: '/does/not/exist',
      }),
    ).toThrow(/static files not found/);
  });

  it('refuses a real app image without the worker image', () => {
    expect(() =>
      configFor({
        environments: { dev: devSettings },
        appImageDigest: TEST_IMAGE_DIGEST,
        appStaticDir: '.',
      }),
    ).toThrow(/workerImageDigest is required/);
  });

  it('rejects a domain outside the hosted zone', () => {
    expect(() =>
      configFor({ environments: { dev: { ...devSettings, domain: 'pictora.example.com' } } }),
    ).toThrow(/subdomain of rpillai.dev/);
  });

  it.each([undefined, 'Pictora', 'pictora-', 'pictora-aws-dev', 'my-cognito', 'a_b'])(
    'rejects the auth domain prefix %s',
    (authDomainPrefix) => {
      expect(() =>
        configFor({ environments: { dev: { ...devSettings, authDomainPrefix } } }),
      ).toThrow(/authDomainPrefix/);
    },
  );

  it.each(['dailyPoints', 'spendCapUsd', 'queueConcurrency', 'budgetUsd'])(
    'requires %s to be a positive integer',
    (key) => {
      expect(() => configFor({ environments: { dev: { ...devSettings, [key]: 0 } } })).toThrow(key);
      expect(() =>
        configFor({ environments: { dev: { ...devSettings, [key]: undefined } } }),
      ).toThrow(key);
    },
  );

  it('fails clearly when the environment is missing', () => {
    expect(() => configFor({ environments: { dev: devSettings } }, 'prod')).toThrow(
      /environments.prod is missing/,
    );
  });
});
