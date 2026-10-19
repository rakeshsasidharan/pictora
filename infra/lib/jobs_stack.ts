import { readFileSync } from 'node:fs';
import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import type { IUserPool } from 'aws-cdk-lib/aws-cognito';
import type { Table } from 'aws-cdk-lib/aws-dynamodb';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Architecture, DockerImageCode, DockerImageFunction } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { Secret, type ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { MODELS_JSON_PATH } from './data_stack.js';
import type { StageConfig } from './stage_config.js';

/** The ECR repository the pipeline pushes the worker image to (`PictoraCicd` stack). */
export const WORKER_REPOSITORY_NAME = 'pictora-worker';

/** Providers with a queue of their own (tech design 3.2). */
export const QUEUE_PROVIDERS = ['openai', 'gemini', 'bedrock'] as const;
export type QueueProvider = (typeof QUEUE_PROVIDERS)[number];

/** Providers called with an API key from Secrets Manager. Bedrock uses the worker's IAM role instead. */
export const SECRET_PROVIDERS = ['openai', 'gemini'] as const;
export type SecretProvider = (typeof SECRET_PROVIDERS)[number];

/** Bedrock image models run on demand in us-west-2 only (PRD registry rules). */
export const BEDROCK_REGION = 'us-west-2';

/** The `providerModelId` of every Bedrock model in `models.json`, which the worker may invoke. */
export function bedrockModelIds(modelsJsonPath: string = MODELS_JSON_PATH): string[] {
  const models = JSON.parse(readFileSync(modelsJsonPath, 'utf8')) as {
    provider: string;
    providerModelId: string;
  }[];
  return models
    .filter((model) => model.provider === 'bedrock')
    .map((model) => model.providerModelId)
    .sort();
}

/** Worker Lambda settings (tech design 3.2). */
export const WORKER_MEMORY_MB = 1536;
export const WORKER_TIMEOUT_SECONDS = 180;
/** The image command that picks the SQS consumer in the worker image. */
export const GENERATE_HANDLER = 'generate.handler';

/** The stuck-job sweeper (tech design 3.2): same image, its own handler, every 5 minutes. */
export const SWEEPER_HANDLER = 'sweeper.handler';
export const SWEEPER_MEMORY_MB = 512;
export const SWEEPER_TIMEOUT_SECONDS = 60;
export const SWEEPER_INTERVAL_MINUTES = 5;

/** The account purge (AUTH-3): same image, its own handler, fed by the purge queue. */
export const PURGE_HANDLER = 'purge.handler';
export const PURGE_MEMORY_MB = 512;
export const PURGE_TIMEOUT_SECONDS = 300;

/** 6 × the worker timeout, as AWS recommends for an SQS event source. */
export const QUEUE_VISIBILITY_TIMEOUT_SECONDS = 6 * WORKER_TIMEOUT_SECONDS;
/** Receives before a message moves to the dead-letter queue. */
export const MAX_RECEIVE_COUNT = 3;
/** The longest SQS allows, to leave time to look into failed jobs. */
export const DEAD_LETTER_RETENTION_DAYS = 14;

export function queueName(envName: string, provider: QueueProvider): string {
  return `pictora-${envName}-${provider}`;
}

/** Secrets Manager secret with a provider's API key, created by hand once per environment (tech design 10). */
export function providerSecretName(envName: string, provider: SecretProvider): string {
  return `pictora/${envName}/${provider}`;
}

export interface JobsStackProps extends StackProps {
  readonly config: StageConfig;
  readonly table: Table;
  readonly imagesBucket: IBucket;
  /** The user pool the purge deletes users from. */
  readonly userPool: IUserPool;
}

/**
 * The job pipeline (tech design 3.2): one SQS queue per provider, a shared dead-letter queue, the worker Lambda
 * that consumes every queue, and the sweeper that fails and refunds stuck jobs every 5 minutes. Both run the
 * `pictora-worker` image by digest.
 */
export class JobsStack extends Stack {
  readonly queues: Readonly<Record<QueueProvider, Queue>>;
  readonly deadLetterQueue: Queue;
  readonly workerFunction: DockerImageFunction;
  readonly sweeperFunction: DockerImageFunction;
  /** Takes `{ sub, username }` from `DELETE /api/me` and deletes the account's data and Cognito user. */
  readonly purgeQueue: Queue;
  readonly purgeFunction: DockerImageFunction;
  readonly providerSecrets: Readonly<Record<SecretProvider, ISecret>>;

  constructor(scope: Construct, id: string, props: JobsStackProps) {
    super(scope, id, props);
    const { config } = props;
    const prod = config.envName === 'prod';

    this.deadLetterQueue = new Queue(this, 'DeadLetterQueue', {
      queueName: `pictora-${config.envName}-dlq`,
      retentionPeriod: Duration.days(DEAD_LETTER_RETENTION_DAYS),
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });

    // Queues hold only messages in flight, so they're deleted with the stack in every environment.
    const queues = {} as Record<QueueProvider, Queue>;
    const secrets = {} as Record<SecretProvider, ISecret>;
    for (const provider of QUEUE_PROVIDERS) {
      const name = capitalize(provider);
      queues[provider] = new Queue(this, `${name}Queue`, {
        queueName: queueName(config.envName, provider),
        visibilityTimeout: Duration.seconds(QUEUE_VISIBILITY_TIMEOUT_SECONDS),
        deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: MAX_RECEIVE_COUNT },
        encryption: QueueEncryption.SQS_MANAGED,
        enforceSSL: true,
      });
    }
    for (const provider of SECRET_PROVIDERS) {
      const name = capitalize(provider);
      // Referenced by name, so the grant covers only this secret, whatever suffix Secrets Manager gave it.
      secrets[provider] = Secret.fromSecretNameV2(
        this,
        `${name}Secret`,
        providerSecretName(config.envName, provider),
      );
    }
    this.queues = queues;
    this.providerSecrets = secrets;

    const repository = Repository.fromRepositoryName(
      this,
      'WorkerRepository',
      WORKER_REPOSITORY_NAME,
    );
    this.workerFunction = new DockerImageFunction(this, 'WorkerFunction', {
      code: DockerImageCode.fromEcr(repository, {
        tagOrDigest: config.workerImageDigest,
        cmd: [GENERATE_HANDLER],
      }),
      architecture: Architecture.ARM_64,
      memorySize: WORKER_MEMORY_MB,
      timeout: Duration.seconds(WORKER_TIMEOUT_SECONDS),
      logGroup: new LogGroup(this, 'WorkerLogGroup', {
        retention: prod ? RetentionDays.THREE_MONTHS : RetentionDays.ONE_MONTH,
        removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      }),
      environment: {
        PICTORA_ENV: config.envName,
        GIT_SHA: config.gitSha,
        TABLE_NAME: props.table.tableName,
        IMAGES_BUCKET: props.imagesBucket.bucketName,
        OPENAI_SECRET_ID: providerSecretName(config.envName, 'openai'),
        GEMINI_SECRET_ID: providerSecretName(config.envName, 'gemini'),
        ...geminiEnvironment(config),
      },
    });

    props.table.grantReadWriteData(this.workerFunction);
    props.imagesBucket.grantPut(this.workerFunction);
    for (const provider of SECRET_PROVIDERS) {
      this.providerSecrets[provider].grantRead(this.workerFunction);
    }
    // Bedrock is called with the worker's role, on the registry's Bedrock models only.
    this.workerFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: bedrockModelIds().map((modelId) =>
          this.formatArn({
            service: 'bedrock',
            region: BEDROCK_REGION,
            account: '',
            resource: 'foundation-model',
            resourceName: modelId,
          }),
        ),
      }),
    );
    this.sweeperFunction = new DockerImageFunction(this, 'SweeperFunction', {
      code: DockerImageCode.fromEcr(repository, {
        tagOrDigest: config.workerImageDigest,
        cmd: [SWEEPER_HANDLER],
      }),
      architecture: Architecture.ARM_64,
      memorySize: SWEEPER_MEMORY_MB,
      timeout: Duration.seconds(SWEEPER_TIMEOUT_SECONDS),
      logGroup: new LogGroup(this, 'SweeperLogGroup', {
        retention: prod ? RetentionDays.THREE_MONTHS : RetentionDays.ONE_MONTH,
        removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      }),
      environment: {
        PICTORA_ENV: config.envName,
        GIT_SHA: config.gitSha,
        TABLE_NAME: props.table.tableName,
      },
    });
    props.table.grantReadWriteData(this.sweeperFunction);
    new Rule(this, 'SweeperSchedule', {
      description: 'Fails and refunds stuck Pictora jobs',
      schedule: Schedule.rate(Duration.minutes(SWEEPER_INTERVAL_MINUTES)),
      targets: [new LambdaFunction(this.sweeperFunction, { retryAttempts: 0 })],
    });

    this.purgeQueue = new Queue(this, 'PurgeQueue', {
      queueName: `pictora-${config.envName}-purge`,
      visibilityTimeout: Duration.seconds(6 * PURGE_TIMEOUT_SECONDS),
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: MAX_RECEIVE_COUNT },
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });
    this.purgeFunction = new DockerImageFunction(this, 'PurgeFunction', {
      code: DockerImageCode.fromEcr(repository, {
        tagOrDigest: config.workerImageDigest,
        cmd: [PURGE_HANDLER],
      }),
      architecture: Architecture.ARM_64,
      memorySize: PURGE_MEMORY_MB,
      timeout: Duration.seconds(PURGE_TIMEOUT_SECONDS),
      logGroup: new LogGroup(this, 'PurgeLogGroup', {
        retention: prod ? RetentionDays.THREE_MONTHS : RetentionDays.ONE_MONTH,
        removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      }),
      environment: {
        PICTORA_ENV: config.envName,
        GIT_SHA: config.gitSha,
        TABLE_NAME: props.table.tableName,
        IMAGES_BUCKET: props.imagesBucket.bucketName,
        COGNITO_USER_POOL_ID: props.userPool.userPoolId,
        PURGE_QUEUE_URL: this.purgeQueue.queueUrl,
      },
    });
    props.table.grantReadWriteData(this.purgeFunction);
    props.imagesBucket.grantDelete(this.purgeFunction);
    this.purgeFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [props.imagesBucket.bucketArn],
      }),
    );
    this.purgeFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ['cognito-idp:AdminDeleteUser'],
        resources: [props.userPool.userPoolArn],
      }),
    );
    // The purge puts its message back on the queue while the user's jobs finish.
    this.purgeQueue.grantSendMessages(this.purgeFunction);
    this.purgeFunction.addEventSource(
      new SqsEventSource(this.purgeQueue, { batchSize: 1, reportBatchItemFailures: true }),
    );

    for (const provider of QUEUE_PROVIDERS) {
      this.workerFunction.addEventSource(
        new SqsEventSource(this.queues[provider], {
          batchSize: 1,
          reportBatchItemFailures: true,
          maxConcurrency: config.queueConcurrency,
        }),
      );
    }
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** The worker's Gemini backend settings; the Vertex AI ones only when the backend is Vertex AI. */
export function geminiEnvironment(config: StageConfig): Record<string, string> {
  if (config.geminiBackend !== 'vertex') return { GEMINI_BACKEND: config.geminiBackend };
  return {
    GEMINI_BACKEND: 'vertex',
    ...(config.geminiVertexLocation ? { GEMINI_VERTEX_LOCATION: config.geminiVertexLocation } : {}),
    ...(config.geminiVertexProject ? { GEMINI_VERTEX_PROJECT: config.geminiVertexProject } : {}),
  };
}
