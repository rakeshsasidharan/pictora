import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { CERTIFICATE_REGION } from '../lib/certificate_stack.js';
import { US_INFERENCE_REGIONS, enhancerModelArns } from '../lib/web_stack.js';
import { testStage, TEST_IMAGE_DIGEST } from './helpers.js';

/** AWS managed CloudFront policy IDs. */
const CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
const CACHING_OPTIMIZED = '658327ea-f89d-4fab-a63d-7e88639e58f6';
const ALL_VIEWER_EXCEPT_HOST_HEADER = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';

const devStage = testStage('PictoraDev', {
  appImageDigest: TEST_IMAGE_DIGEST,
  workerImageDigest: TEST_IMAGE_DIGEST,
  gitSha: 'abc123',
});
const dev = Template.fromStack(devStage.web);
const prod = Template.fromStack(testStage('PictoraProd').web);

function distributionConfig(template: Template) {
  const [distribution] = Object.values(template.findResources('AWS::CloudFront::Distribution'));
  return distribution?.Properties.DistributionConfig;
}

function appFunction(template: Template) {
  const functions = template.findResources('AWS::Lambda::Function', {
    Properties: { PackageType: 'Image' },
  });
  const values = Object.values(functions);
  expect(values).toHaveLength(1);
  return values[0]?.Properties;
}

describe('Web stack: app Lambda', () => {
  it('runs the app image by digest on arm64 with 1024 MB and a 30 s timeout', () => {
    const props = appFunction(dev);
    expect(props.Architectures).toEqual(['arm64']);
    expect(props.MemorySize).toBe(1024);
    expect(props.Timeout).toBe(30);
    expect(JSON.stringify(props.Code.ImageUri)).toContain(`/pictora-app@${TEST_IMAGE_DIGEST}`);
  });

  it('passes the commit SHA and environment settings', () => {
    expect(appFunction(dev).Environment.Variables).toMatchObject({
      GIT_SHA: 'abc123',
      PICTORA_ENV: 'dev',
      DAILY_POINTS: '1000',
      SPEND_CAP_CENTS: '2000',
      APP_CONFIG_PARAMETER: '/pictora/dev/app-config',
      COGNITO_USER_POOL_ID: expect.anything(),
      COGNITO_DOMAIN: expect.anything(),
      ORIGIN_VERIFY_SECRET_ARN: { Ref: expect.stringMatching(/^OriginVerifySecret/) },
    });
  });

  it('passes the enhancer model and secret names, and reads only the secrets it needs', () => {
    expect(appFunction(dev).Environment.Variables).toMatchObject({
      ENHANCER_MODEL: 'mock',
      OPENAI_SECRET_ID: 'pictora/dev/openai',
    });
    expect(appFunction(dev).Environment.Variables).not.toHaveProperty('GEMINI_SECRET_ID');
    expect(appFunction(prod).Environment.Variables).toMatchObject({
      ENHANCER_MODEL: 'bedrock:us.openai.gpt-5.6-luna',
      OPENAI_SECRET_ID: 'pictora/prod/openai',
    });
    const reads = (template: Template) =>
      JSON.stringify(
        Object.values(template.findResources('AWS::IAM::Policy')).map(
          (policy) => policy.Properties.PolicyDocument.Statement,
        ),
      );
    expect(reads(dev)).toContain('secret:pictora/dev/openai');
    expect(reads(dev)).not.toContain('secret:pictora/dev/gemini');
    expect(reads(dev)).not.toContain('bedrock:InvokeModel');
  });

  it('may invoke only the Bedrock enhancer profile and its model in the US regions', () => {
    const statements = Object.values(prod.findResources('AWS::IAM::Policy')).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement as Record<string, unknown>[],
    );
    const invoke = statements.filter((statement) => statement.Action === 'bedrock:InvokeModel');
    expect(invoke).toHaveLength(1);
    const resources = JSON.stringify(invoke[0]?.Resource);
    expect(resources).toContain(':bedrock:us-west-2:');
    expect(resources).toContain(':inference-profile/us.openai.gpt-5.6-luna');
    for (const region of US_INFERENCE_REGIONS) {
      expect(resources).toContain(`:bedrock:${region}::foundation-model/openai.gpt-5.6-luna`);
    }
  });

  it('builds the Bedrock enhancer resources for a bare model and a global profile', () => {
    const stack = devStage.web;
    expect(JSON.stringify(enhancerModelArns(stack, 'openai.gpt-5.6-luna'))).toContain(
      ':bedrock:us-west-2::foundation-model/openai.gpt-5.6-luna',
    );
    const global = JSON.stringify(enhancerModelArns(stack, 'global.openai.gpt-5.6-luna'));
    expect(global).toContain(':inference-profile/global.openai.gpt-5.6-luna');
    expect(global).toContain(':bedrock:*::foundation-model/openai.gpt-5.6-luna');
  });

  it('passes the provider queue URLs from the Jobs stack, and may send to those queues only', () => {
    const variables = appFunction(dev).Environment.Variables;
    expect(JSON.stringify(variables.OPENAI_QUEUE_URL)).toMatch(/OpenaiQueue/);
    expect(JSON.stringify(variables.GEMINI_QUEUE_URL)).toMatch(/GeminiQueue/);
    expect(JSON.stringify(variables.BEDROCK_QUEUE_URL)).toMatch(/BedrockQueue/);
    expect(devStage.web.dependencies).toContain(devStage.jobs);
    const sendStatements = Object.values(dev.findResources('AWS::IAM::Policy')).flatMap((policy) =>
      (policy.Properties.PolicyDocument.Statement as { Action: unknown; Resource: unknown }[])
        .filter((statement) => JSON.stringify(statement.Action).includes('sqs:SendMessage'))
        .map((statement) => JSON.stringify(statement.Resource)),
    );
    expect(sendStatements.length).toBeGreaterThan(0);
    expect(sendStatements.join()).toMatch(/OpenaiQueue/);
    expect(sendStatements.join()).toMatch(/GeminiQueue/);
    expect(sendStatements.join()).toMatch(/BedrockQueue/);
    expect(sendStatements.join()).not.toMatch(/DeadLetter/);
  });

  it('passes the purge queue URL and may send account purges to it', () => {
    expect(JSON.stringify(appFunction(dev).Environment.Variables.PURGE_QUEUE_URL)).toMatch(
      /PurgeQueue/,
    );
    const statements = Object.values(dev.findResources('AWS::IAM::Policy')).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement as Record<string, unknown>[],
    );
    const send = statements.filter((s) => JSON.stringify(s.Action).includes('sqs:SendMessage'));
    expect(JSON.stringify(send.map((s) => s.Resource))).toMatch(/PurgeQueue/);
  });

  it('may disable and sign out users of its own pool, and not delete them', () => {
    const statements = Object.values(dev.findResources('AWS::IAM::Policy')).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement as Record<string, unknown>[],
    );
    const cognito = statements.filter((s) => JSON.stringify(s.Action).includes('cognito-idp:'));
    expect(cognito).toHaveLength(1);
    expect(cognito[0]?.Action).toEqual([
      'cognito-idp:AdminDisableUser',
      'cognito-idp:AdminUserGlobalSignOut',
    ]);
    expect(JSON.stringify(cognito[0]?.Resource)).toMatch(/UserPool/);
  });

  it('reads, writes and deletes image objects with exact actions, and lists only the images bucket', () => {
    const statements = Object.values(dev.findResources('AWS::IAM::Policy'))
      .filter((policy) =>
        JSON.stringify(policy.Properties.Roles).includes('AppFunctionServiceRole'),
      )
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement as Record<string, unknown>[]);
    const s3 = statements.filter((s) => JSON.stringify(s.Action).includes('s3:'));
    expect(s3.map((s) => s.Action)).toEqual([
      ['s3:DeleteObject', 's3:GetObject', 's3:PutObject'],
      's3:ListBucket',
    ]);
    const objects = JSON.stringify(s3[0]?.Resource);
    expect(objects).toMatch(/ImagesBucket.*\/users\/\*/);
    expect(objects).toMatch(/ImagesBucket.*\/uploads\/\*/);
    expect(JSON.stringify(s3[1]?.Resource)).toMatch(/ImagesBucket/);
  });

  it('reserves 20 concurrent executions in prod only', () => {
    expect(appFunction(prod).ReservedConcurrentExecutions).toBe(20);
    expect(appFunction(dev).ReservedConcurrentExecutions).toBeUndefined();
  });

  it('exposes a public Function URL in response streaming mode', () => {
    dev.hasResourceProperties('AWS::Lambda::Url', {
      AuthType: 'NONE',
      InvokeMode: 'RESPONSE_STREAM',
    });
  });

  it('keeps logs 30 days in dev and 90 days in prod', () => {
    dev.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
    prod.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 90 });
  });

  it('generates the origin verify secret per environment', () => {
    dev.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'pictora/dev/origin-verify',
      GenerateSecretString: Match.objectLike({ PasswordLength: 48 }),
    });
  });
});

function appClient(template: Template) {
  const [client] = Object.values(template.findResources('AWS::Cognito::UserPoolClient'));
  return client?.Properties;
}

describe('Web stack: Cognito app client', () => {
  it('uses the authorization code flow with no client secret and the agreed token lifetimes', () => {
    expect(appClient(dev)).toMatchObject({
      ClientName: 'pictora-dev-web',
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthScopes: ['openid', 'email', 'profile'],
      SupportedIdentityProviders: ['COGNITO', 'Google'],
      AccessTokenValidity: 60,
      IdTokenValidity: 60,
      RefreshTokenValidity: 30 * 24 * 60,
      TokenValidityUnits: { AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'minutes' },
      PreventUserExistenceErrors: 'ENABLED',
      EnableTokenRevocation: true,
    });
  });

  it('calls back to the dev domain, and to local next dev', () => {
    expect(appClient(dev)).toMatchObject({
      CallbackURLs: [
        'https://pictora.rpillai.dev/auth/callback',
        'http://localhost:3000/auth/callback',
      ],
      LogoutURLs: ['https://pictora.rpillai.dev/', 'http://localhost:3000/'],
    });
  });

  it('calls back to the CloudFront domain in prod, which has no custom domain yet', () => {
    const domain = { 'Fn::GetAtt': [expect.stringMatching(/^Distribution/), 'DomainName'] };
    expect(appClient(prod)).toMatchObject({
      CallbackURLs: [{ 'Fn::Join': ['', ['https://', domain, '/auth/callback']] }],
      LogoutURLs: [{ 'Fn::Join': ['', ['https://', domain, '/']] }],
    });
  });

  it('is deployed after the Auth stack, which holds the pool and the Google provider', () => {
    expect(devStage.web.dependencies).toContain(devStage.auth);
  });

  it('publishes the site URL and client ID to the app config parameter, readable by the app', () => {
    dev.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/pictora/dev/app-config',
      Value: {
        'Fn::Join': [
          '',
          [
            '{"siteUrl":"https://pictora.rpillai.dev","cognitoClientId":"',
            { Ref: Match.stringLikeRegexp('^AppClient') },
            '"}',
          ],
        ],
      },
    });
    dev.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'ssm:GetParameter',
            Resource: {
              'Fn::Join': ['', Match.arrayWith([':parameter/pictora/dev/app-config'])],
            },
          }),
        ]),
      },
    });
  });
});

describe('Web stack: outputs', () => {
  it('outputs the site URL for the deploy pipeline', () => {
    dev.hasOutput('SiteUrl', { Value: 'https://pictora.rpillai.dev' });
    prod.hasOutput('SiteUrl', {
      Value: {
        'Fn::Join': [
          '',
          ['https://', { 'Fn::GetAtt': [Match.stringLikeRegexp('^Distribution'), 'DomainName'] }],
        ],
      },
    });
  });
});

describe('Web stack: CloudFront', () => {
  it('sends everything else to the Function URL with the origin verify header and no caching', () => {
    const config = distributionConfig(dev);
    const appOrigin = config.Origins.find(
      (origin: { Id: string }) => origin.Id === config.DefaultCacheBehavior.TargetOriginId,
    );
    expect(appOrigin.CustomOriginConfig.OriginProtocolPolicy).toBe('https-only');
    expect(JSON.stringify(appOrigin.DomainName)).toContain('FunctionUrl');
    expect(appOrigin.OriginCustomHeaders).toEqual([
      {
        HeaderName: 'X-Origin-Verify',
        HeaderValue: {
          'Fn::Join': [
            '',
            [
              '{{resolve:secretsmanager:',
              { Ref: expect.stringMatching(/^OriginVerifySecret/) },
              ':SecretString:::}}',
            ],
          ],
        },
      },
    ]);
    expect(config.DefaultCacheBehavior).toMatchObject({
      CachePolicyId: CACHING_DISABLED,
      OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST_HEADER,
      ViewerProtocolPolicy: 'redirect-to-https',
    });
    expect(config.DefaultCacheBehavior.AllowedMethods).toContain('POST');
  });

  it('serves static assets from the assets bucket through Origin Access Control, cached', () => {
    const config = distributionConfig(dev);
    const s3Origin = config.Origins.find(
      (origin: { S3OriginConfig?: unknown }) => origin.S3OriginConfig,
    );
    expect(s3Origin.OriginAccessControlId).toBeDefined();
    expect(config.CacheBehaviors).toEqual(
      ['/_next/static/*', '/static/*'].map((PathPattern) =>
        expect.objectContaining({
          PathPattern,
          TargetOriginId: s3Origin.Id,
          CachePolicyId: CACHING_OPTIMIZED,
          AllowedMethods: ['GET', 'HEAD'],
          ViewerProtocolPolicy: 'redirect-to-https',
        }),
      ),
    );
    dev.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
  });

  it('serves the dev domain with the us-east-1 certificate', () => {
    const config = distributionConfig(dev);
    expect(config.Aliases).toEqual(['pictora.rpillai.dev']);
    expect(config.ViewerCertificate).toMatchObject({
      SslSupportMethod: 'sni-only',
      MinimumProtocolVersion: 'TLSv1.2_2021',
    });
    expect(JSON.stringify(config.ViewerCertificate.AcmCertificateArn)).toContain(
      CERTIFICATE_REGION,
    );
  });

  it('points A and AAAA alias records at the distribution in the rpillai.dev zone', () => {
    for (const Type of ['A', 'AAAA']) {
      dev.hasResourceProperties('AWS::Route53::RecordSet', {
        Name: 'pictora.rpillai.dev.',
        Type,
        HostedZoneId: 'Z0000000000PLACEHOLDER',
        AliasTarget: Match.objectLike({ HostedZoneId: Match.anyValue() }),
      });
    }
  });

  it('uses the hosted zone ID from context', () => {
    const template = Template.fromStack(testStage('PictoraDev', { hostedZoneId: 'ZREALZONE' }).web);
    template.hasResourceProperties('AWS::Route53::RecordSet', { HostedZoneId: 'ZREALZONE' });
  });

  it('serves prod on the CloudFront domain until it has one of its own', () => {
    const config = distributionConfig(prod);
    expect(config.Aliases).toBeUndefined();
    prod.resourceCountIs('AWS::Route53::RecordSet', 0);
  });
});

describe('Web stack: assets bucket', () => {
  it('is encrypted, blocks public access and allows reads only from CloudFront', () => {
    dev.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    dev.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 's3:GetObject',
            Principal: { Service: 'cloudfront.amazonaws.com' },
          }),
        ]),
      },
    });
  });

  it('uploads .next/static with a one-year immutable cache, and public/static', () => {
    dev.hasResourceProperties('Custom::CDKBucketDeployment', {
      DestinationBucketKeyPrefix: '_next/static/',
      Prune: false,
      SystemMetadata: { 'cache-control': 'public, max-age=31536000, immutable' },
    });
    dev.hasResourceProperties('Custom::CDKBucketDeployment', {
      DestinationBucketKeyPrefix: 'static/',
      Prune: false,
    });
  });
});
