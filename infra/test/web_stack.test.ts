import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { CERTIFICATE_REGION } from '../lib/certificate_stack.js';
import { testStage, TEST_IMAGE_DIGEST } from './helpers.js';

/** AWS managed CloudFront policy IDs. */
const CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
const CACHING_OPTIMIZED = '658327ea-f89d-4fab-a63d-7e88639e58f6';
const ALL_VIEWER_EXCEPT_HOST_HEADER = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';

const devStage = testStage('PictoraDev', { appImageDigest: TEST_IMAGE_DIGEST, gitSha: 'abc123' });
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
      SITE_URL: 'https://pictora.rpillai.dev',
      ORIGIN_VERIFY_SECRET_ARN: { Ref: expect.stringMatching(/^OriginVerifySecret/) },
    });
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
