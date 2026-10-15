import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertNotProd,
  environmentDomains,
  readEnvironmentDomains,
  requireCredentials,
  resolveBaseUrl,
  resolveConfig,
} from '../src/config.js';

const domains = { dev: 'pictora.rpillai.dev', prod: 'pictora.example.dev' };

describe('environmentDomains', () => {
  it('reads the dev and prod domains from cdk.json context', () => {
    const cdkJson = {
      context: {
        environments: {
          dev: { domain: 'pictora.rpillai.dev', dailyPoints: 1000 },
          prod: { domain: 'pictora.example.dev' },
        },
      },
    };
    expect(environmentDomains(cdkJson)).toEqual(domains);
  });

  it('leaves out a missing or empty domain', () => {
    const cdkJson = { context: { environments: { dev: { domain: '' }, prod: {} } } };
    expect(environmentDomains(cdkJson)).toEqual({ dev: undefined, prod: undefined });
    expect(environmentDomains(null)).toEqual({ dev: undefined, prod: undefined });
  });

  it('reads the real infra/cdk.json, which has a dev domain', () => {
    const cdkJson = fileURLToPath(new URL('../../infra/cdk.json', import.meta.url));
    expect(readEnvironmentDomains(cdkJson).dev).toBe('pictora.rpillai.dev');
  });
});

describe('resolveBaseUrl', () => {
  it('prefers E2E_BASE_URL, then BASE_URL, then SITE_URL', () => {
    const all = {
      E2E_BASE_URL: 'https://a.test',
      BASE_URL: 'https://b.test',
      SITE_URL: 'https://c.test',
    };
    expect(resolveBaseUrl(all, domains)).toBe('https://a.test');
    expect(resolveBaseUrl({ ...all, E2E_BASE_URL: '' }, domains)).toBe('https://b.test');
    expect(resolveBaseUrl({ SITE_URL: ' https://c.test ' }, domains)).toBe('https://c.test');
  });

  it('defaults to the dev domain', () => {
    expect(resolveBaseUrl({}, domains)).toBe('https://pictora.rpillai.dev');
  });

  it('fails when nothing is set and there is no dev domain', () => {
    expect(() => resolveBaseUrl({}, {})).toThrow(/E2E_BASE_URL/);
  });
});

describe('assertNotProd', () => {
  it('allows the dev domain and returns its origin', () => {
    expect(assertNotProd('https://pictora.rpillai.dev/', domains)).toBe(
      'https://pictora.rpillai.dev',
    );
    expect(assertNotProd('https://PICTORA.rpillai.dev', domains)).toBe(
      'https://pictora.rpillai.dev',
    );
  });

  it('allows a local server', () => {
    expect(assertNotProd('http://localhost:3000', domains)).toBe('http://localhost:3000');
    expect(assertNotProd('http://127.0.0.1:3000', domains)).toBe('http://127.0.0.1:3000');
    expect(assertNotProd('http://[::1]:3000', domains)).toBe('http://[::1]:3000');
  });

  it('refuses the prod domain', () => {
    expect(() => assertNotProd('https://pictora.example.dev', domains)).toThrow(/against prod/);
    expect(() => assertNotProd('https://Pictora.Example.dev/gallery', domains)).toThrow(
      /against prod/,
    );
  });

  it('refuses any other host, such as the prod CloudFront domain', () => {
    expect(() => assertNotProd('https://d111111abcdef8.cloudfront.net', domains)).toThrow(
      /only the dev domain/,
    );
    expect(() => assertNotProd('https://evil.pictora.rpillai.dev', domains)).toThrow(
      /only the dev domain/,
    );
    expect(() => assertNotProd('https://pictora.rpillai.dev', {})).toThrow(/none set/);
  });

  it('refuses something that is not an http URL', () => {
    expect(() => assertNotProd('pictora.rpillai.dev', domains)).toThrow(/not a valid URL/);
    expect(() => assertNotProd('ftp://pictora.rpillai.dev', domains)).toThrow(/http or https/);
  });
});

describe('resolveConfig', () => {
  it('resolves the base URL and the test user', () => {
    const config = resolveConfig(
      {
        E2E_BASE_URL: 'https://pictora.rpillai.dev/',
        E2E_USER_EMAIL: ' e2e@example.com ',
        E2E_USER_PASSWORD: 'secret',
      },
      domains,
    );
    expect(config).toEqual({
      baseUrl: 'https://pictora.rpillai.dev',
      userEmail: 'e2e@example.com',
      userPassword: 'secret',
    });
  });

  it('refuses prod even when it comes from SITE_URL', () => {
    expect(() => resolveConfig({ SITE_URL: 'https://pictora.example.dev' }, domains)).toThrow(
      /against prod/,
    );
  });
});

describe('requireCredentials', () => {
  const baseUrl = 'https://pictora.rpillai.dev';

  it('returns the test user', () => {
    expect(
      requireCredentials({ baseUrl, userEmail: 'e2e@example.com', userPassword: 'pw' }),
    ).toEqual({ email: 'e2e@example.com', password: 'pw' });
  });

  it('names whatever is missing', () => {
    expect(() => requireCredentials({ baseUrl })).toThrow(
      /Set E2E_USER_EMAIL and E2E_USER_PASSWORD/,
    );
    expect(() => requireCredentials({ baseUrl, userEmail: 'e2e@example.com' })).toThrow(
      /Set E2E_USER_PASSWORD to/,
    );
  });
});
