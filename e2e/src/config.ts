import { readFileSync } from 'node:fs';

/** Per-environment settings from `infra/cdk.json`; only the domains matter here. */
export interface EnvironmentDomains {
  dev?: string;
  prod?: string;
}

export interface E2eConfig {
  /** Origin of the site under test, without a trailing slash. */
  baseUrl: string;
  /** Cognito test user in the dev user pool; only the sign-in setup needs it. */
  userEmail?: string;
  userPassword?: string;
}

export interface Credentials {
  email: string;
  password: string;
}

type Env = Readonly<Record<string, string | undefined>>;

/** Hosts a developer may point the suite at besides dev: a local `next dev` or `next start`. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const CDK_JSON = new URL('../../infra/cdk.json', import.meta.url);

/** Reads the dev and prod domains from `context.environments` in `infra/cdk.json`. */
export function readEnvironmentDomains(path: URL | string = CDK_JSON): EnvironmentDomains {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return environmentDomains(parsed);
}

/** Picks the dev and prod domains out of a parsed `cdk.json`, ignoring anything else. */
export function environmentDomains(cdkJson: unknown): EnvironmentDomains {
  const environments = field(field(cdkJson, 'context'), 'environments');
  return {
    dev: stringField(field(environments, 'dev'), 'domain'),
    prod: stringField(field(environments, 'prod'), 'domain'),
  };
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const result = field(value, key);
  return typeof result === 'string' && result !== '' ? result : undefined;
}

/**
 * The site under test: `E2E_BASE_URL` (set by the deploy pipeline), then `BASE_URL`, then `SITE_URL`, then the
 * dev domain, so `npm run test:e2e` runs against dev with no settings.
 */
export function resolveBaseUrl(env: Env, domains: EnvironmentDomains): string {
  const configured = [env.E2E_BASE_URL, env.BASE_URL, env.SITE_URL]
    .map((value) => value?.trim())
    .find((value) => value);
  if (configured) return configured;
  if (domains.dev) return `https://${domains.dev}`;
  throw new Error('Set E2E_BASE_URL to the dev site URL: infra/cdk.json has no dev domain.');
}

/**
 * Refuses to run against anything but dev or a local server (tech design 13). The suite signs in and creates
 * images, so it must never touch prod: the prod domain is refused outright, and any other unknown host is
 * refused too, because prod is served on its CloudFront domain until it has a domain of its own.
 */
export function assertNotProd(baseUrl: string, domains: EnvironmentDomains): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`The e2e base URL is not a valid URL: ${baseUrl}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`The e2e base URL must be http or https: ${baseUrl}`);
  }
  const host = url.hostname.toLowerCase();
  if (domains.prod && host === domains.prod.toLowerCase()) {
    throw new Error(`Refusing to run the e2e suite against prod (${host}). Point it at dev.`);
  }
  const allowed = LOCAL_HOSTS.has(host) || (domains.dev && host === domains.dev.toLowerCase());
  if (!allowed) {
    throw new Error(
      `Refusing to run the e2e suite against ${host}: only the dev domain (${domains.dev ?? 'none set'}) ` +
        'and localhost are allowed, so it can never reach prod.',
    );
  }
  return url.origin;
}

/** Resolves and checks the suite's settings from the environment. */
export function resolveConfig(env: Env, domains: EnvironmentDomains): E2eConfig {
  const baseUrl = assertNotProd(resolveBaseUrl(env, domains), domains);
  return {
    baseUrl,
    userEmail: env.E2E_USER_EMAIL?.trim() || undefined,
    userPassword: env.E2E_USER_PASSWORD || undefined,
  };
}

/** The test user's credentials, or an error naming what is missing. */
export function requireCredentials(config: E2eConfig): Credentials {
  const { userEmail, userPassword } = config;
  if (!userEmail || !userPassword) {
    const missing = [
      userEmail ? undefined : 'E2E_USER_EMAIL',
      userPassword ? undefined : 'E2E_USER_PASSWORD',
    ].filter((name) => name !== undefined);
    throw new Error(
      `Set ${missing.join(' and ')} to the dev Cognito test user (see e2e/README.md).`,
    );
  }
  return { email: userEmail, password: userPassword };
}

let cached: E2eConfig | undefined;

/** The settings for this run, from `process.env` and `infra/cdk.json`. */
export function e2eConfig(): E2eConfig {
  cached ??= resolveConfig(process.env, readEnvironmentDomains());
  return cached;
}
