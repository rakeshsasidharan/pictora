import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import type { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { OAuthScope, UserPoolClient } from 'aws-cdk-lib/aws-cognito';
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  HttpVersion,
  OriginRequestPolicy,
  PriceClass,
  SecurityPolicyProtocol,
  ViewerProtocolPolicy,
  type BehaviorOptions,
} from 'aws-cdk-lib/aws-cloudfront';
import { FunctionUrlOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import type { Table } from 'aws-cdk-lib/aws-dynamodb';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import {
  Architecture,
  DockerImageCode,
  DockerImageFunction,
  FunctionUrlAuthType,
  InvokeMode,
  type FunctionUrl,
} from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { ARecord, AaaaRecord, HostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  ObjectOwnership,
  type IBucket,
} from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, CacheControl, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import type { IQueue } from 'aws-cdk-lib/aws-sqs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import {
  ACCESS_TOKEN_VALIDITY,
  OAUTH_SCOPES,
  REFRESH_TOKEN_VALIDITY,
  type AuthStack,
} from './auth_stack.js';
import { QUEUE_PROVIDERS, type QueueProvider } from './jobs_stack.js';
import { HOSTED_ZONE_NAME, type StageConfig } from './stage_config.js';

/** The ECR repository the pipeline pushes the app image to (`PictoraCicd` stack). */
export const APP_REPOSITORY_NAME = 'pictora-app';

/** Header CloudFront adds to every request to the Function URL; the app rejects requests without it. */
export const ORIGIN_VERIFY_HEADER = 'X-Origin-Verify';

/** Paths CloudFront serves from the assets bucket; everything else goes to the app. */
export const ASSET_PATH_PATTERNS = ['/_next/static/*', '/static/*'] as const;

/** App Lambda settings (tech design 3.1). */
export const APP_MEMORY_MB = 1024;
export const APP_TIMEOUT_SECONDS = 30;

/** Sign-in callback and sign-out landing paths in the app. */
export const AUTH_CALLBACK_PATH = '/auth/callback';
export const SIGNED_OUT_PATH = '/';

/** Local `next dev`, allowed as a callback in dev only. */
export const LOCAL_DEV_URL = 'http://localhost:3000';

/** The app environment variable with a provider queue's URL, for example `OPENAI_QUEUE_URL`. */
export function queueUrlVariable(provider: QueueProvider): string {
  return `${provider.toUpperCase()}_QUEUE_URL`;
}

/** SSM parameter with the app's runtime config: `{ siteUrl, cognitoClientId }`. */
export function appConfigParameterName(envName: string): string {
  return `/pictora/${envName}/app-config`;
}

export interface WebStackProps extends StackProps {
  readonly config: StageConfig;
  readonly table: Table;
  readonly imagesBucket: IBucket;
  readonly auth: AuthStack;
  /** The provider queues the job API sends `{ jobId }` to. */
  readonly queues: Readonly<Record<QueueProvider, IQueue>>;
  /** The queue `DELETE /api/me` sends the account purge to (AUTH-3). */
  readonly purgeQueue: IQueue;
  /** Required when the stage has a domain. */
  readonly certificate?: ICertificate;
}

/**
 * The Next.js app on Lambda behind CloudFront (tech design 3.1): the app Lambda with a streaming Function URL,
 * the static assets bucket, the distribution and the DNS records.
 */
export class WebStack extends Stack {
  readonly appFunction: DockerImageFunction;
  readonly functionUrl: FunctionUrl;
  readonly assetsBucket: Bucket;
  readonly distribution: Distribution;
  readonly originVerifySecret: Secret;
  readonly userPoolClient: UserPoolClient;
  readonly siteUrl: string;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);
    const { config } = props;
    const prod = config.envName === 'prod';
    const removalPolicy = prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    this.originVerifySecret = new Secret(this, 'OriginVerifySecret', {
      secretName: `pictora/${config.envName}/origin-verify`,
      description: `Value of the ${ORIGIN_VERIFY_HEADER} header CloudFront sends to the app`,
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });

    const appConfigParameter = appConfigParameterName(config.envName);
    const repository = Repository.fromRepositoryName(this, 'AppRepository', APP_REPOSITORY_NAME);
    this.appFunction = new DockerImageFunction(this, 'AppFunction', {
      code: DockerImageCode.fromEcr(repository, { tagOrDigest: config.appImageDigest }),
      architecture: Architecture.ARM_64,
      memorySize: APP_MEMORY_MB,
      timeout: Duration.seconds(APP_TIMEOUT_SECONDS),
      reservedConcurrentExecutions: config.appReservedConcurrency,
      logGroup: new LogGroup(this, 'AppLogGroup', {
        retention: prod ? RetentionDays.THREE_MONTHS : RetentionDays.ONE_MONTH,
        removalPolicy,
      }),
      environment: {
        PICTORA_ENV: config.envName,
        GIT_SHA: config.gitSha,
        ORIGIN_VERIFY_SECRET_ARN: this.originVerifySecret.secretArn,
        TABLE_NAME: props.table.tableName,
        IMAGES_BUCKET: props.imagesBucket.bucketName,
        DAILY_POINTS: String(config.dailyPoints),
        SPEND_CAP_CENTS: String(config.spendCapUsd * 100),
        COGNITO_USER_POOL_ID: props.auth.userPool.userPoolId,
        COGNITO_DOMAIN: props.auth.domainBaseUrl,
        APP_CONFIG_PARAMETER: appConfigParameter,
        PURGE_QUEUE_URL: props.purgeQueue.queueUrl,
        ...Object.fromEntries(
          QUEUE_PROVIDERS.map((provider) => [
            queueUrlVariable(provider),
            props.queues[provider].queueUrl,
          ]),
        ),
      },
    });
    // Built from the name, not the parameter: the parameter depends on the distribution, which depends on
    // this function, so referencing it here would be a dependency cycle.
    this.appFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          this.formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: appConfigParameter.slice(1),
          }),
        ],
      }),
    );
    this.originVerifySecret.grantRead(this.appFunction);
    props.table.grantReadWriteData(this.appFunction);
    props.imagesBucket.grantReadWrite(this.appFunction);
    for (const provider of QUEUE_PROVIDERS)
      props.queues[provider].grantSendMessages(this.appFunction);
    props.purgeQueue.grantSendMessages(this.appFunction);
    // Account deletion disables the user and signs them out at once; the purge deletes them.
    this.appFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ['cognito-idp:AdminDisableUser', 'cognito-idp:AdminUserGlobalSignOut'],
        resources: [props.auth.userPool.userPoolArn],
      }),
    );

    this.functionUrl = this.appFunction.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
      invokeMode: InvokeMode.RESPONSE_STREAM,
    });

    this.assetsBucket = new Bucket(this, 'AssetsBucket', {
      bucketName: `pictora-${config.envName}-assets-${this.account}`,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      // Rebuilt from the app image on every deploy, so nothing in it needs keeping.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const assetsBehavior: BehaviorOptions = {
      origin: S3BucketOrigin.withOriginAccessControl(this.assetsBucket),
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
      cachePolicy: CachePolicy.CACHING_OPTIMIZED,
      compress: true,
    };

    if (config.domain && !props.certificate) {
      throw new Error(`A certificate is required for ${config.domain}`);
    }
    this.distribution = new Distribution(this, 'Distribution', {
      comment: `Pictora ${config.envName}`,
      defaultBehavior: {
        origin: new FunctionUrlOrigin(this.functionUrl, {
          customHeaders: {
            [ORIGIN_VERIFY_HEADER]: this.originVerifySecret.secretValue.unsafeUnwrap(),
          },
        }),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachePolicy: CachePolicy.CACHING_DISABLED,
        // A Function URL rejects a forwarded Host header.
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        compress: true,
      },
      additionalBehaviors: Object.fromEntries(
        ASSET_PATH_PATTERNS.map((pattern) => [pattern, assetsBehavior]),
      ),
      domainNames: config.domain ? [config.domain] : undefined,
      certificate: config.domain ? props.certificate : undefined,
      // Only applies with a custom certificate; the default CloudFront certificate's policy is fixed.
      minimumProtocolVersion: config.domain ? SecurityPolicyProtocol.TLS_V1_2_2021 : undefined,
      httpVersion: HttpVersion.HTTP2_AND_3,
      priceClass: PriceClass.PRICE_CLASS_100,
    });

    this.deployAssets(config);

    this.siteUrl = config.domain
      ? `https://${config.domain}`
      : `https://${this.distribution.distributionDomainName}`;
    this.userPoolClient = this.createUserPoolClient(props, this.siteUrl);
    new StringParameter(this, 'AppConfigParameter', {
      parameterName: appConfigParameter,
      description: 'Pictora app runtime config: site URL and Cognito app client ID',
      stringValue: Stack.of(this).toJsonString({
        siteUrl: this.siteUrl,
        cognitoClientId: this.userPoolClient.userPoolClientId,
      }),
    });

    // The deploy pipeline reads this from the outputs file for the smoke test and e2e (CI/CD design 4.3).
    new CfnOutput(this, 'SiteUrl', {
      description: 'Site URL: the custom domain, or the CloudFront domain when there is none',
      value: this.siteUrl,
    });

    if (config.domain) {
      const zone = HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        zoneName: HOSTED_ZONE_NAME,
        hostedZoneId: config.hostedZoneId,
      });
      const target = RecordTarget.fromAlias(new CloudFrontTarget(this.distribution));
      new ARecord(this, 'SiteRecord', { zone, recordName: config.domain, target });
      new AaaaRecord(this, 'SiteRecordIpv6', { zone, recordName: config.domain, target });
    }
  }

  /**
   * The Cognito app client (tech design 8): authorization code flow with PKCE and no client secret, since the
   * code is exchanged by the app's server with a one-time PKCE verifier. Dev also allows local `next dev`.
   */
  private createUserPoolClient(props: WebStackProps, siteUrl: string): UserPoolClient {
    const { config, auth } = props;
    const baseUrls = config.envName === 'dev' ? [siteUrl, LOCAL_DEV_URL] : [siteUrl];
    // Created in this stack, not with userPool.addClient, which would put it in the Auth stack.
    const client = new UserPoolClient(this, 'AppClient', {
      userPool: auth.userPool,
      userPoolClientName: `pictora-${config.envName}-web`,
      generateSecret: false,
      authFlows: {},
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: OAUTH_SCOPES.map((scope) => OAuthScope.custom(scope)),
        callbackUrls: baseUrls.map((url) => `${url}${AUTH_CALLBACK_PATH}`),
        logoutUrls: baseUrls.map((url) => `${url}${SIGNED_OUT_PATH}`),
      },
      supportedIdentityProviders: auth.identityProviders,
      accessTokenValidity: ACCESS_TOKEN_VALIDITY,
      idTokenValidity: ACCESS_TOKEN_VALIDITY,
      refreshTokenValidity: REFRESH_TOKEN_VALIDITY,
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
    });
    // The client can only name Google once the provider exists.
    client.node.addDependency(auth.googleProvider);
    return client;
  }

  /**
   * Uploads the Next.js static files and `public` to the assets bucket. File names under `_next/static` are
   * content hashed, so they're cached for a year and never pruned: pages still open keep loading old chunks.
   */
  private deployAssets(config: StageConfig): void {
    if (existsSync(config.appStaticDir)) {
      new BucketDeployment(this, 'DeployNextStatic', {
        sources: [Source.asset(config.appStaticDir)],
        destinationBucket: this.assetsBucket,
        destinationKeyPrefix: '_next/static/',
        cacheControl: [
          CacheControl.setPublic(),
          CacheControl.maxAge(Duration.days(365)),
          CacheControl.immutable(),
        ],
        prune: false,
        memoryLimit: 512,
      });
    }

    // Only `public/static/` is routed to the bucket; other public files are served by the app.
    const publicStaticDir = join(config.appPublicDir, 'static');
    if (existsSync(publicStaticDir)) {
      new BucketDeployment(this, 'DeployPublicStatic', {
        sources: [Source.asset(publicStaticDir)],
        destinationBucket: this.assetsBucket,
        destinationKeyPrefix: 'static/',
        cacheControl: [CacheControl.setPublic(), CacheControl.maxAge(Duration.hours(1))],
        prune: false,
        memoryLimit: 512,
      });
    }
  }
}
