import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CustomResource, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  HttpMethods,
  ObjectOwnership,
} from 'aws-cdk-lib/aws-s3';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import type { StageConfig } from './stage_config.js';

/** Unused uploads expire after a day (tech design 5.3). */
export const UPLOADS_PREFIX = 'uploads/';
export const UPLOAD_EXPIRY_DAYS = 1;
/** Old object versions (prod only, where versioning is on) expire after 30 days. */
export const NONCURRENT_VERSION_EXPIRY_DAYS = 30;

/** The model registry seed, the source of truth for model config (tech design 6.1). */
export const MODELS_JSON_PATH = fileURLToPath(
  new URL('../../packages/core/models.json', import.meta.url),
);
const REGISTRY_SEED_ENTRY = fileURLToPath(
  new URL('../lambda/registry_seed_handler.ts', import.meta.url),
);

/** The index the registry is read through: every registry item has `GSI1PK = REGISTRY`. */
export const TABLE_GSI1 = 'GSI1';

export interface DataStackProps extends StackProps {
  readonly config: StageConfig;
}

/**
 * The DynamoDB table and the images bucket (tech design sections 4 and 9).
 * Prod keeps both if the stack is deleted, and has point-in-time recovery and bucket versioning.
 */
export class DataStack extends Stack {
  readonly table: Table;
  readonly imagesBucket: Bucket;
  readonly registrySeed: RegistrySeed;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { envName, domain } = props.config;
    const prod = envName === 'prod';
    const removalPolicy = prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    this.table = new Table(this, 'Table', {
      tableName: `pictora-${envName}`,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: prod },
      deletionProtection: prod,
      removalPolicy,
    });
    this.table.addGlobalSecondaryIndex({
      indexName: TABLE_GSI1,
      partitionKey: { name: 'GSI1PK', type: AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: AttributeType.STRING },
    });

    // Bucket names are global, so the account ID keeps them unique without committing it.
    this.imagesBucket = new Bucket(this, 'ImagesBucket', {
      bucketName: `pictora-${envName}-images-${this.account}`,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: prod,
      // Browsers upload with presigned POST and read with presigned GET from the site only.
      cors: domain
        ? [
            {
              allowedOrigins: [`https://${domain}`],
              allowedMethods: [HttpMethods.GET, HttpMethods.HEAD, HttpMethods.POST],
              allowedHeaders: ['*'],
              maxAge: 3000,
            },
          ]
        : undefined,
      lifecycleRules: [
        {
          id: 'expire-unused-uploads',
          prefix: UPLOADS_PREFIX,
          expiration: Duration.days(UPLOAD_EXPIRY_DAYS),
        },
        {
          id: 'expire-old-versions',
          noncurrentVersionExpiration: Duration.days(NONCURRENT_VERSION_EXPIRY_DAYS),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
      removalPolicy,
      autoDeleteObjects: !prod,
    });

    this.registrySeed = new RegistrySeed(this, 'RegistrySeed', {
      table: this.table,
      gitSha: props.config.gitSha,
      logRetention: prod ? RetentionDays.THREE_MONTHS : RetentionDays.ONE_MONTH,
      removalPolicy,
    });
  }
}

export interface RegistrySeedProps {
  readonly table: Table;
  /** Changes with every deploy, so the seed runs on every deploy, not only when `models.json` changes. */
  readonly gitSha: string;
  readonly logRetention: RetentionDays;
  readonly removalPolicy: RemovalPolicy;
}

/**
 * A custom resource that upserts `models.json` into the table on every deploy, keeping kill switches already
 * set in DynamoDB (tech design 6.1). The handler can query the registry index and write items, nothing else.
 */
export class RegistrySeed extends Construct {
  readonly handler: NodejsFunction;
  readonly resource: CustomResource;

  constructor(scope: Construct, id: string, props: RegistrySeedProps) {
    super(scope, id);
    const { table } = props;

    this.handler = new NodejsFunction(this, 'Handler', {
      entry: REGISTRY_SEED_ENTRY,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.minutes(2),
      bundling: { format: OutputFormat.ESM, minify: true, sourceMap: false },
      logGroup: new LogGroup(this, 'HandlerLogGroup', {
        retention: props.logRetention,
        removalPolicy: props.removalPolicy,
      }),
    });
    this.handler.addToRolePolicy(
      new PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [`${table.tableArn}/index/${TABLE_GSI1}`],
      }),
    );
    this.handler.addToRolePolicy(
      new PolicyStatement({ actions: ['dynamodb:BatchWriteItem'], resources: [table.tableArn] }),
    );

    const provider = new Provider(this, 'Provider', {
      onEventHandler: this.handler,
      logGroup: new LogGroup(this, 'ProviderLogGroup', {
        retention: props.logRetention,
        removalPolicy: props.removalPolicy,
      }),
    });

    // Minified, so the request stays small; validated again by the handler before anything is written.
    const seed = JSON.stringify(JSON.parse(readFileSync(MODELS_JSON_PATH, 'utf8')));
    this.resource = new CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::PictoraRegistrySeed',
      properties: { TableName: table.tableName, Seed: seed, GitSha: props.gitSha },
    });
  }
}
