import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  HttpMethods,
  ObjectOwnership,
} from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import type { StageConfig } from './stage_config.js';

/** Unused uploads expire after a day (tech design 5.3). */
export const UPLOADS_PREFIX = 'uploads/';
export const UPLOAD_EXPIRY_DAYS = 1;
/** Old object versions (prod only, where versioning is on) expire after 30 days. */
export const NONCURRENT_VERSION_EXPIRY_DAYS = 30;

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
      indexName: 'GSI1',
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
  }
}
