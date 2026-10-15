import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { bedrockModelIds } from '../lib/jobs_stack.js';
import { PLACEHOLDER_IMAGE_DIGEST } from '../lib/stage_config.js';
import { testStage, TEST_IMAGE_DIGEST } from './helpers.js';

const devStage = testStage('PictoraDev', {
  appImageDigest: TEST_IMAGE_DIGEST,
  workerImageDigest: TEST_IMAGE_DIGEST,
  gitSha: 'abc123',
});
const dev = Template.fromStack(devStage.jobs);
const prod = Template.fromStack(testStage('PictoraProd').jobs);

function logicalId(template: Template, type: string, props: Record<string, unknown>): string {
  const ids = Object.keys(template.findResources(type, { Properties: props }));
  expect(ids).toHaveLength(1);
  return ids[0] as string;
}

function workerFunction(template: Template) {
  const functions = template.findResources('AWS::Lambda::Function', {
    Properties: { PackageType: 'Image' },
  });
  const values = Object.values(functions);
  expect(values).toHaveLength(1);
  return values[0]?.Properties;
}

function workerPolicyStatements(template: Template): Record<string, unknown>[] {
  const policies = Object.values(template.findResources('AWS::IAM::Policy')).filter((policy) =>
    JSON.stringify(policy.Properties.Roles).includes('WorkerFunctionServiceRole'),
  );
  expect(policies).toHaveLength(1);
  return policies[0]?.Properties.PolicyDocument.Statement;
}

describe('Jobs stack: queues', () => {
  const dlqId = logicalId(dev, 'AWS::SQS::Queue', { QueueName: 'pictora-dev-dlq' });

  it.each(['openai', 'gemini', 'bedrock'])(
    'creates the %s queue with a 1,080 s visibility timeout and 3 receives before the dead-letter queue',
    (provider) => {
      dev.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: `pictora-dev-${provider}`,
        VisibilityTimeout: 1080,
        SqsManagedSseEnabled: true,
        RedrivePolicy: {
          deadLetterTargetArn: { 'Fn::GetAtt': [dlqId, 'Arn'] },
          maxReceiveCount: 3,
        },
      });
    },
  );

  it('has one queue per provider plus the shared dead-letter queue', () => {
    const names = Object.values(dev.findResources('AWS::SQS::Queue'))
      .map((queue) => queue.Properties.QueueName)
      .sort();
    expect(names).toEqual([
      'pictora-dev-bedrock',
      'pictora-dev-dlq',
      'pictora-dev-gemini',
      'pictora-dev-openai',
    ]);
  });

  it('keeps dead letters for 14 days', () => {
    dev.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'pictora-dev-dlq',
      MessageRetentionPeriod: 14 * 24 * 60 * 60,
      SqsManagedSseEnabled: true,
      RedrivePolicy: Match.absent(),
    });
  });

  it('names the queues per environment', () => {
    for (const name of [
      'pictora-prod-openai',
      'pictora-prod-gemini',
      'pictora-prod-bedrock',
      'pictora-prod-dlq',
    ]) {
      prod.hasResourceProperties('AWS::SQS::Queue', { QueueName: name });
    }
  });

  it('denies queue access without TLS', () => {
    const policies = Object.values(dev.findResources('AWS::SQS::QueuePolicy'));
    expect(policies).toHaveLength(4);
    for (const policy of policies) {
      expect(policy.Properties.PolicyDocument.Statement).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      );
    }
  });
});

describe('Jobs stack: worker Lambda', () => {
  it('runs the worker image by digest on arm64 with 1536 MB and a 180 s timeout', () => {
    const props = workerFunction(dev);
    expect(props.Architectures).toEqual(['arm64']);
    expect(props.MemorySize).toBe(1536);
    expect(props.Timeout).toBe(180);
    expect(JSON.stringify(props.Code.ImageUri)).toContain(`/pictora-worker@${TEST_IMAGE_DIGEST}`);
    expect(props.ImageConfig).toEqual({ Command: ['generate.handler'] });
  });

  it('synthesises with the placeholder digest when no worker image is given', () => {
    expect(JSON.stringify(workerFunction(prod).Code.ImageUri)).toContain(
      `/pictora-worker@${PLACEHOLDER_IMAGE_DIGEST}`,
    );
  });

  it('passes the table, bucket, secret names and commit SHA', () => {
    expect(workerFunction(dev).Environment.Variables).toMatchObject({
      PICTORA_ENV: 'dev',
      GIT_SHA: 'abc123',
      TABLE_NAME: expect.anything(),
      IMAGES_BUCKET: expect.anything(),
      OPENAI_SECRET_ID: 'pictora/dev/openai',
      GEMINI_SECRET_ID: 'pictora/dev/gemini',
    });
  });

  it('keeps logs 30 days in dev and 90 days in prod', () => {
    dev.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
    prod.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 90 });
  });

  it.each(['openai', 'gemini', 'bedrock'])(
    'consumes the %s queue one message at a time, reporting batch item failures, at most 5 at once',
    (provider) => {
      const queueId = logicalId(dev, 'AWS::SQS::Queue', { QueueName: `pictora-dev-${provider}` });
      dev.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
        EventSourceArn: { 'Fn::GetAtt': [queueId, 'Arn'] },
        FunctionName: { Ref: Match.stringLikeRegexp('^WorkerFunction') },
        BatchSize: 1,
        FunctionResponseTypes: ['ReportBatchItemFailures'],
        ScalingConfig: { MaximumConcurrency: 5 },
      });
    },
  );

  it('has exactly one event source mapping per queue', () => {
    dev.resourceCountIs('AWS::Lambda::EventSourceMapping', 3);
  });

  it('takes the maximum concurrency from the environment settings', () => {
    const stage = testStage('PictoraDev');
    const environments = structuredClone(
      stage.node.tryGetContext('environments') as Record<string, Record<string, unknown>>,
    );
    environments.dev = { ...environments.dev, queueConcurrency: 3 };
    const template = Template.fromStack(testStage('PictoraDev', { environments }).jobs);
    const mappings = Object.values(template.findResources('AWS::Lambda::EventSourceMapping'));
    expect(mappings.map((mapping) => mapping.Properties.ScalingConfig)).toEqual([
      { MaximumConcurrency: 3 },
      { MaximumConcurrency: 3 },
      { MaximumConcurrency: 3 },
    ]);
  });
});

describe('Jobs stack: worker IAM', () => {
  const statements = workerPolicyStatements(dev);
  const actionsOf = (statement: Record<string, unknown>) => [statement.Action].flat() as string[];

  it('reads and writes the table and its indexes only', () => {
    const statement = statements.find((s) => actionsOf(s).includes('dynamodb:PutItem'));
    expect(actionsOf(statement ?? {})).toEqual(
      expect.arrayContaining(['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:Query']),
    );
    const resources = JSON.stringify(statement?.Resource);
    expect(resources).toContain('TableCD117FA1Arn');
    expect(resources).toContain('/index/*');
    expect(actionsOf(statement ?? {})).not.toContain('dynamodb:DeleteTable');
  });

  it('can only put objects in the images bucket', () => {
    const s3Statements = statements.filter((s) => actionsOf(s).some((a) => a.startsWith('s3:')));
    expect(s3Statements).toHaveLength(1);
    const [statement] = s3Statements;
    expect(actionsOf(statement ?? {})).toContain('s3:PutObject');
    expect(actionsOf(statement ?? {}).filter((a) => /^s3:(Get|Delete|List)/.test(a))).toEqual([]);
    expect(JSON.stringify(statement?.Resource)).toMatch(/ImagesBucket.*Arn.*\/\*/);
  });

  it('reads only the openai and gemini secrets of its environment, by name', () => {
    const secretStatements = statements.filter((s) =>
      actionsOf(s).some((a) => a.startsWith('secretsmanager:')),
    );
    expect(secretStatements).toHaveLength(1);
    const [statement] = secretStatements;
    expect(actionsOf(statement ?? {}).sort()).toEqual([
      'secretsmanager:DescribeSecret',
      'secretsmanager:GetSecretValue',
    ]);
    const resources = [statement?.Resource].flat().map((resource) => JSON.stringify(resource));
    expect(resources).toHaveLength(2);
    expect(resources.join()).toContain(':secret:pictora/dev/openai-??????');
    expect(resources.join()).toContain(':secret:pictora/dev/gemini-??????');
    for (const resource of resources) {
      expect(resource).toContain('{"Ref":"AWS::AccountId"}');
      expect(resource).not.toContain('*');
    }
  });

  it('consumes only its own queues', () => {
    const statement = statements.find((s) => actionsOf(s).includes('sqs:ReceiveMessage'));
    expect(statement?.Resource).toEqual(
      expect.arrayContaining([
        { 'Fn::GetAtt': [expect.stringMatching(/^OpenaiQueue/), 'Arn'] },
        { 'Fn::GetAtt': [expect.stringMatching(/^GeminiQueue/), 'Arn'] },
        { 'Fn::GetAtt': [expect.stringMatching(/^BedrockQueue/), 'Arn'] },
      ]),
    );
    expect([statement?.Resource].flat()).toHaveLength(3);
  });

  it('may invoke only the Bedrock models in models.json, in us-west-2', () => {
    const bedrockStatements = statements.filter((s) =>
      actionsOf(s).some((a) => a.startsWith('bedrock:')),
    );
    expect(bedrockStatements).toHaveLength(1);
    const [statement] = bedrockStatements;
    expect(actionsOf(statement ?? {})).toEqual(['bedrock:InvokeModel']);
    expect([statement?.Resource].flat()).toEqual(
      bedrockModelIds().map((modelId) => `arn:aws:bedrock:us-west-2::foundation-model/${modelId}`),
    );
  });

  it('has no wildcard actions or resources', () => {
    for (const statement of statements) {
      for (const action of actionsOf(statement)) expect(action).not.toBe('*');
      expect(statement.Resource).not.toBe('*');
    }
  });
});

describe('bedrockModelIds', () => {
  it('lists the Stability models on Bedrock from models.json', () => {
    expect(bedrockModelIds()).toEqual([
      'stability.sd3-5-large-v1:0',
      'stability.stable-image-core-v1:1',
      'stability.stable-image-ultra-v1:1',
    ]);
  });
});
