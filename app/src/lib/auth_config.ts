import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

/** Config is cached like secrets, for 5 minutes (tech design 10). */
export const AUTH_CONFIG_CACHE_MS = 5 * 60 * 1000;

/** What the app needs to sign users in with Cognito (tech design 8). */
export interface AuthConfig {
  /** For example `us-west-2_AbCdEf123`. */
  userPoolId: string;
  /** Public app client (no secret); the code exchange is protected by PKCE. */
  clientId: string;
  /** Origin of the managed login pages, for example `https://<prefix>.auth.us-west-2.amazoncognito.com`. */
  cognitoDomain: string;
  /** Origin of the site, without a trailing slash: the callback base and the only accepted `Origin`. */
  siteUrl: string;
}

/** The environment variables `authConfig` reads. */
export interface AuthConfigEnv {
  [name: string]: string | undefined;
  COGNITO_USER_POOL_ID?: string;
  COGNITO_DOMAIN?: string;
  /** Local development: the client ID and site URL straight from the environment. */
  COGNITO_CLIENT_ID?: string;
  SITE_URL?: string;
  /** Deployed: the SSM parameter holding `{ siteUrl, cognitoClientId }`, written by the Web stack. */
  APP_CONFIG_PARAMETER?: string;
}

let client: SSMClient | undefined;
let cached: { name: string; value: AppConfigParameter; expiresAt: number } | undefined;

interface AppConfigParameter {
  siteUrl: string;
  cognitoClientId: string;
}

/**
 * The auth config, or undefined when sign-in isn't configured. The user pool and login domain come from the
 * environment. The client ID and site URL come from `COGNITO_CLIENT_ID` and `SITE_URL` when set, otherwise
 * from the `APP_CONFIG_PARAMETER` SSM parameter: they depend on the CloudFront distribution, which depends on
 * the app Lambda, so they can't be Lambda environment variables.
 */
export async function authConfig(
  env: AuthConfigEnv = process.env,
  now: number = Date.now(),
): Promise<AuthConfig | undefined> {
  const userPoolId = env.COGNITO_USER_POOL_ID;
  const cognitoDomain = env.COGNITO_DOMAIN;
  if (!userPoolId || !cognitoDomain) return undefined;

  let clientId = env.COGNITO_CLIENT_ID;
  let siteUrl = env.SITE_URL;
  if (!clientId || !siteUrl) {
    if (!env.APP_CONFIG_PARAMETER) return undefined;
    const parameter = await readAppConfigParameter(env.APP_CONFIG_PARAMETER, now);
    clientId = parameter.cognitoClientId;
    siteUrl = parameter.siteUrl;
  }
  return {
    userPoolId,
    clientId,
    cognitoDomain: trimTrailingSlash(cognitoDomain),
    siteUrl: trimTrailingSlash(siteUrl),
  };
}

async function readAppConfigParameter(name: string, now: number): Promise<AppConfigParameter> {
  if (cached && cached.name === name && cached.expiresAt > now) return cached.value;

  client ??= new SSMClient({});
  const { Parameter } = await client.send(new GetParameterCommand({ Name: name }));
  const value = parseAppConfig(Parameter?.Value, name);
  cached = { name, value, expiresAt: now + AUTH_CONFIG_CACHE_MS };
  return value;
}

function parseAppConfig(raw: string | undefined, name: string): AppConfigParameter {
  const parsed: unknown = raw ? JSON.parse(raw) : undefined;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).siteUrl !== 'string' ||
    typeof (parsed as Record<string, unknown>).cognitoClientId !== 'string'
  ) {
    throw new Error(`SSM parameter ${name} must hold { siteUrl, cognitoClientId }`);
  }
  return parsed as AppConfigParameter;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Clears the cached parameter and client; for tests. */
export function resetAuthConfigCache(): void {
  cached = undefined;
  client = undefined;
}
