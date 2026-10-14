import { readFileSync } from 'node:fs';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { MODELS_JSON_PATH } from '../lib/data_stack.js';
import { testStage } from './helpers.js';

const dev = Template.fromStack(testStage('PictoraDev').data);
const prod = Template.fromStack(testStage('PictoraProd').data);

describe.each([
  ['dev', dev],
  ['prod', prod],
])('Data stack (%s)', (envName, template) => {
  it('creates the single table with PK, SK, GSI1 and ttl, on demand', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: `pictora-${envName}`,
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    });
  });

  it('encrypts the images bucket and blocks all public access', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
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
  });

  it('expires unused uploads after a day and old versions after 30 days', () => {
    const [bucket] = Object.values(template.findResources('AWS::S3::Bucket'));
    const rules = bucket?.Properties.LifecycleConfiguration.Rules;
    expect(rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ Prefix: 'uploads/', ExpirationInDays: 1, Status: 'Enabled' }),
        expect.objectContaining({
          NoncurrentVersionExpiration: { NoncurrentDays: 30 },
          Status: 'Enabled',
        }),
      ]),
    );
  });
});

describe('Data stack per environment', () => {
  it('turns on point-in-time recovery in prod only', () => {
    prod.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      DeletionProtectionEnabled: true,
    });
    dev.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
      DeletionProtectionEnabled: false,
    });
  });

  it('retains the table and images bucket in prod only', () => {
    for (const type of ['AWS::DynamoDB::Table', 'AWS::S3::Bucket']) {
      prod.hasResource(type, { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
      dev.hasResource(type, { DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete' });
    }
  });

  it('versions the images bucket in prod only', () => {
    prod.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
    });
    const [devBucket] = Object.values(dev.findResources('AWS::S3::Bucket'));
    expect(devBucket?.Properties.VersioningConfiguration).toBeUndefined();
  });

  it('allows presigned POST and GET from the dev site only', () => {
    dev.hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: {
        CorsRules: [
          {
            AllowedOrigins: ['https://pictora.rpillai.dev'],
            AllowedMethods: ['GET', 'HEAD', 'POST'],
            AllowedHeaders: ['*'],
            MaxAge: 3000,
          },
        ],
      },
    });
  });
});

describe('Data stack: model registry seed', () => {
  const template = Template.fromStack(testStage('PictoraDev', { gitSha: 'abc123' }).data);
  const seed = JSON.parse(readFileSync(MODELS_JSON_PATH, 'utf8'));

  it('runs a custom resource with the whole seed on every deploy', () => {
    const resources = Object.values(template.findResources('Custom::PictoraRegistrySeed'));
    expect(resources).toHaveLength(1);
    const props = resources[0]?.Properties;
    expect(props.TableName).toEqual({ Ref: expect.stringMatching(/^Table/) });
    expect(JSON.parse(props.Seed)).toEqual(seed);
    expect(props.GitSha).toBe('abc123');
    expect(props.ServiceToken).toEqual({
      'Fn::GetAtt': [expect.stringMatching(/ProviderframeworkonEvent/), 'Arn'],
    });
  });

  it('runs the handler on arm64 Node.js 22', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      Handler: 'index.handler',
      Timeout: 120,
    });
  });

  it('lets the handler query the registry index and write items, and nothing more', () => {
    const policies = template.findResources('AWS::IAM::Policy', {
      Properties: { PolicyName: Match.stringLikeRegexp('^RegistrySeedHandler') },
    });
    const statements = Object.values(policies).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement,
    );
    expect(statements).toEqual([
      {
        Effect: 'Allow',
        Action: 'dynamodb:Query',
        Resource: {
          'Fn::Join': [
            '',
            [{ 'Fn::GetAtt': [expect.stringMatching(/^Table/), 'Arn'] }, '/index/GSI1'],
          ],
        },
      },
      {
        Effect: 'Allow',
        Action: 'dynamodb:BatchWriteItem',
        Resource: { 'Fn::GetAtt': [expect.stringMatching(/^Table/), 'Arn'] },
      },
    ]);
  });
});
