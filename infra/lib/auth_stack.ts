import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import {
  AccountRecovery,
  FeaturePlan,
  ProviderAttribute,
  UserPool,
  UserPoolClientIdentityProvider,
  UserPoolDomain,
  UserPoolGroup,
  UserPoolIdentityProviderGoogle,
  type UserPoolIdentityProvider,
} from 'aws-cdk-lib/aws-cognito';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import type { StageConfig } from './stage_config.js';

/** Cognito group whose members can use the admin pages and APIs (tech design 7 and 8). */
export const ADMINS_GROUP = 'admins';

/** Scopes the app asks for at sign-in. */
export const OAUTH_SCOPES = ['openid', 'email', 'profile'] as const;

/** Token lifetimes (tech design 8). The ID token lasts as long as the access token. */
export const ACCESS_TOKEN_VALIDITY = Duration.hours(1);
export const REFRESH_TOKEN_VALIDITY = Duration.days(30);

/** Secrets Manager secret, created by hand, with the Google OAuth client as `{ clientId, clientSecret }`. */
export function googleOAuthSecretName(envName: string): string {
  return `pictora/${envName}/google-oauth`;
}

export interface AuthStackProps extends StackProps {
  readonly config: StageConfig;
}

/**
 * The Cognito user pool (tech design 8): email as the username with verification, Google as a federated
 * provider, the managed login domain and the `admins` group. The app client lives in the `Web` stack,
 * because its callback URLs need the site URL, which is the CloudFront domain when there is no custom domain.
 */
export class AuthStack extends Stack {
  readonly userPool: UserPool;
  readonly domain: UserPoolDomain;
  readonly googleProvider: UserPoolIdentityProvider;
  /** Origin of the managed login pages, for example `https://<prefix>.auth.us-west-2.amazoncognito.com`. */
  readonly domainBaseUrl: string;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);
    const { envName, authDomainPrefix } = props.config;
    const prod = envName === 'prod';

    this.userPool = new UserPool(this, 'UserPool', {
      userPoolName: `pictora-${envName}`,
      featurePlan: FeaturePlan.ESSENTIALS,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      keepOriginal: { email: true },
      // Federated sign-in updates mapped attributes on every login, so email must be mutable.
      standardAttributes: { email: { required: true, mutable: true } },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      deletionProtection: prod,
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    const googleSecret = Secret.fromSecretNameV2(
      this,
      'GoogleOAuthSecret',
      googleOAuthSecretName(envName),
    );
    this.googleProvider = new UserPoolIdentityProviderGoogle(this, 'Google', {
      userPool: this.userPool,
      // Resolved by CloudFormation at deploy time; the value never appears in the template.
      clientId: googleSecret.secretValueFromJson('clientId').unsafeUnwrap(),
      clientSecretValue: googleSecret.secretValueFromJson('clientSecret'),
      scopes: [...OAUTH_SCOPES],
      attributeMapping: {
        email: ProviderAttribute.GOOGLE_EMAIL,
        emailVerified: ProviderAttribute.GOOGLE_EMAIL_VERIFIED,
      },
    });

    this.domain = this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: authDomainPrefix },
    });
    this.domainBaseUrl = this.domain.baseUrl();

    new UserPoolGroup(this, 'AdminsGroup', {
      userPool: this.userPool,
      groupName: ADMINS_GROUP,
      description: 'Pictora administrators',
    });
  }

  /** Identity providers the app client offers: email and password, and Google. */
  get identityProviders(): UserPoolClientIdentityProvider[] {
    return [UserPoolClientIdentityProvider.COGNITO, UserPoolClientIdentityProvider.GOOGLE];
  }
}
