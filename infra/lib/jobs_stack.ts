import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import type { Table } from 'aws-cdk-lib/aws-dynamodb';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import { Architecture, DockerImageCode, DockerImageFunction } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { Secret, type ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { StageConfig } from './stage_config.js';

/** The ECR repository the pipeline pushes the worker image to (`PictoraCicd` stack). */
export const WORKER_REPOSITORY_NAME = 'pictora-worker';

/** Providers with a queue of their own. Bedrock joins in P1 (tech design 3.2). */
export const QUEUE_PROVIDERS = ['openai', 'gemini'] as const;
export type QueueProvider = (typeof QUEUE_PROVIDERS)[number];

/** Worker Lambda settings (tech design 3.2). */
export const WORKER_MEMORY_MB = 1536;
export const WORKER_TIMEOUT_SECONDS = 180;
/** The image command that picks the SQS consumer in the worker image. */
export const GENERATE_HANDLER = 'generate.handler';

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
export function providerSecretName(envName: string, provider: QueueProvider): string {
  return `pictora/${envName}/${provider}`;
}

export interface JobsStackProps extends StackProps {
  readonly config: StageConfig;
  readonly table: Table;
  readonly imagesBucket: IBucket;
}

/**
 * The job pipeline (tech design 3.2): one SQS queue per provider, a shared dead-letter queue, and the worker
 * Lambda that consumes every queue. The worker runs the `pictora-worker` image by digest.
 */
export class JobsStack extends Stack {
  readonly queues: Readonly<Record<QueueProvider, Queue>>;
  readonly deadLetterQueue: Queue;
  readonly workerFunction: DockerImageFunction;
  readonly providerSecrets: Readonly<Record<QueueProvider, ISecret>>;

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
    const secrets = {} as Record<QueueProvider, ISecret>;
    for (const provider of QUEUE_PROVIDERS) {
      const name = capitalize(provider);
      queues[provider] = new Queue(this, `${name}Queue`, {
        queueName: queueName(config.envName, provider),
        visibilityTimeout: Duration.seconds(QUEUE_VISIBILITY_TIMEOUT_SECONDS),
        deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: MAX_RECEIVE_COUNT },
        encryption: QueueEncryption.SQS_MANAGED,
        enforceSSL: true,
      });
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
      },
    });

    props.table.grantReadWriteData(this.workerFunction);
    props.imagesBucket.grantPut(this.workerFunction);
    for (const provider of QUEUE_PROVIDERS) {
      this.providerSecrets[provider].grantRead(this.workerFunction);
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
