import type { AuthConfig } from './auth_config';

/** App paths for the sign-in flow (tech design 8). */
export const LOGIN_PATH = '/auth/login';
export const CALLBACK_PATH = '/auth/callback';
export const LOGOUT_PATH = '/auth/logout';

/** Scopes asked for at sign-in; the Web stack's app client allows the same. */
export const OAUTH_SCOPES = 'openid email profile';

/** Tokens from the Cognito token endpoint. A refresh response has no refresh token. */
export interface TokenSet {
  accessToken: string;
  idToken: string;
  refreshToken?: string;
  /** Lifetime of the access and ID tokens, in seconds. */
  expiresIn: number;
}

/** The token endpoint refused a request, for example `invalid_grant` for a wrong PKCE verifier. */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`Cognito token endpoint returned ${status} ${code}`);
    this.name = 'OAuthError';
  }
}

export type FetchFn = typeof fetch;

export function callbackUrl(config: AuthConfig): string {
  return `${config.siteUrl}${CALLBACK_PATH}`;
}

/**
 * The managed login URL for the authorization code flow with PKCE. With `identityProvider`, Cognito skips its
 * own page and goes straight to that provider, for example `Google`.
 */
export function authorizeUrl(
  config: AuthConfig,
  options: { state: string; codeChallenge: string; identityProvider?: string },
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: callbackUrl(config),
    scope: OAUTH_SCOPES,
    state: options.state,
    code_challenge: options.codeChallenge,
    code_challenge_method: 'S256',
  });
  if (options.identityProvider) params.set('identity_provider', options.identityProvider);
  return `${config.cognitoDomain}/oauth2/authorize?${params}`;
}

/** Cognito's logout endpoint, which ends the managed login session and returns to the site. */
export function logoutUrl(config: AuthConfig): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    logout_uri: `${config.siteUrl}/`,
  });
  return `${config.cognitoDomain}/logout?${params}`;
}

/** Exchanges an authorization code for tokens, proving possession of the PKCE code verifier. */
export async function exchangeCode(
  config: AuthConfig,
  options: { code: string; codeVerifier: string },
  fetchFn: FetchFn = fetch,
): Promise<TokenSet> {
  return requestTokens(
    config,
    {
      grant_type: 'authorization_code',
      code: options.code,
      code_verifier: options.codeVerifier,
      redirect_uri: callbackUrl(config),
    },
    fetchFn,
  );
}

/** Gets new access and ID tokens with a refresh token. */
export async function refreshTokens(
  config: AuthConfig,
  refreshToken: string,
  fetchFn: FetchFn = fetch,
): Promise<TokenSet> {
  return requestTokens(
    config,
    { grant_type: 'refresh_token', refresh_token: refreshToken },
    fetchFn,
  );
}

async function requestTokens(
  config: AuthConfig,
  params: Record<string, string>,
  fetchFn: FetchFn,
): Promise<TokenSet> {
  const response = await fetchFn(`${config.cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, client_id: config.clientId }),
    cache: 'no-store',
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new OAuthError(
      typeof body.error === 'string' ? body.error : 'unknown_error',
      response.status,
    );
  }
  const { access_token, id_token, refresh_token, expires_in } = body;
  if (typeof access_token !== 'string' || typeof id_token !== 'string') {
    throw new OAuthError('missing_tokens', response.status);
  }
  return {
    accessToken: access_token,
    idToken: id_token,
    refreshToken: typeof refresh_token === 'string' ? refresh_token : undefined,
    expiresIn: typeof expires_in === 'number' ? expires_in : 3600,
  };
}
