import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

/**
 * Holds the DynamoDB table and the images bucket (tech design sections 4 and 9).
 * A stage needs at least one stack for `cdk synth` to succeed, so this stack exists from the start.
 */
export class DataStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
  }
}
