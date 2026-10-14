import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { JwtExpiredError } from 'aws-jwt-verify/error';
import type { Jwks } from 'aws-jwt-verify/jwk';
import type { AuthConfig } from './auth_config';
import type { Session } from './session';

/** Checks Cognito access and ID tokens. */
export interface TokenVerifier {
  verify(tokens: { accessToken: string; idToken: string }): Promise<VerifyResult>;
  /** Preloads the signing keys instead of fetching them from Cognito, as tests do with a local JWKS. */
  cacheJwks(jwks: Jwks): void;
}

export type VerifyResult =
  { status: 'valid'; session: Session } | { status: 'expired' } | { status: 'invalid' };

/**
 * A verifier for one user pool and app client, using `aws-jwt-verify` with its JWKS cache. The access token
 * proves the session; the ID token, for the same user, carries the email.
 */
export function createTokenVerifier(
  config: Pick<AuthConfig, 'userPoolId' | 'clientId'>,
): TokenVerifier {
  const { userPoolId, clientId } = config;
  const access = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: 'access' });
  const id = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: 'id' });

  return {
    cacheJwks(jwks) {
      access.cacheJwks(jwks);
      id.cacheJwks(jwks);
    },
    async verify({ accessToken, idToken }) {
      try {
        const accessClaims = await access.verify(accessToken);
        const idClaims = await id.verify(idToken);
        if (idClaims.sub !== accessClaims.sub || typeof idClaims.email !== 'string') {
          return { status: 'invalid' };
        }
        return {
          status: 'valid',
          session: {
            sub: accessClaims.sub,
            email: idClaims.email,
            groups: accessClaims['cognito:groups'] ?? [],
          },
        };
      } catch (error) {
        return { status: error instanceof JwtExpiredError ? 'expired' : 'invalid' };
      }
    },
  };
}

let shared: { key: string; verifier: TokenVerifier } | undefined;

/** One verifier per user pool and client, so the JWKS is fetched once per Lambda instance. */
export function sharedTokenVerifier(
  config: Pick<AuthConfig, 'userPoolId' | 'clientId'>,
): TokenVerifier {
  const key = `${config.userPoolId}/${config.clientId}`;
  if (shared?.key !== key) shared = { key, verifier: createTokenVerifier(config) };
  return shared.verifier;
}
