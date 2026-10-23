import { Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { testApp } from './helpers.js';

interface Statement {
  Effect: string;
  Action: string | string[];
}

interface FoundPolicy {
  stack: string;
  id: string;
  actions: string[];
}

/** Every IAM statement's actions, from `AWS::IAM::Policy` resources and roles' inline policies. */
function policies(): FoundPolicy[] {
  const stacks = testApp()
    .node.findAll()
    .filter((construct): construct is Stack => Stack.isStack(construct));
  return stacks.flatMap((stack) => {
    const template = Template.fromStack(stack);
    const documents: [string, { Statement: Statement[] }][] = [
      ...Object.entries(template.findResources('AWS::IAM::Policy')).map(
        ([id, resource]) =>
          [id, resource.Properties.PolicyDocument] as [string, { Statement: Statement[] }],
      ),
      ...Object.entries(template.findResources('AWS::IAM::Role')).flatMap(([id, resource]) =>
        (
          (resource.Properties.Policies ?? []) as { PolicyDocument: { Statement: Statement[] } }[]
        ).map((policy) => [id, policy.PolicyDocument] as [string, { Statement: Statement[] }]),
      ),
    ];
    return documents.map(([id, document]) => ({
      stack: stack.stackName,
      id,
      actions: document.Statement.filter((statement) => statement.Effect === 'Allow').flatMap(
        (statement) => [statement.Action].flat(),
      ),
    }));
  });
}

/**
 * Roles CDK creates for its own constructs: `BucketDeployment` syncs (and prunes) the static assets, dev's
 * auto-delete empties buckets on stack delete, and the custom resource provider framework invokes its handler.
 * Their actions are fixed by CDK; the delete check below still covers them.
 */
const CDK_OWNED = [/^CustomCDKBucketDeployment/, /^CustomS3AutoDeleteObjects/, /Providerframework/];

/** Actions that would delete the table or a bucket, or loosen a bucket's policy. */
const STATEFUL_DELETES = [
  'dynamodb:DeleteTable',
  'dynamodb:DeleteBackup',
  's3:DeleteBucket',
  's3:DeleteBucketPolicy',
  's3:PutBucketPolicy',
];

/** Whether an IAM action pattern (which may hold `*` and `?`) grants the action. */
function grants(pattern: string, action: string): boolean {
  const regex = pattern
    .split('')
    .map((char) =>
      char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.+^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');
  return new RegExp(`^${regex}$`, 'i').test(action);
}

describe('IAM policies (tech design 12)', () => {
  const found = policies();

  it('finds the Pictora function policies', () => {
    const ids = found.map((policy) => `${policy.stack}/${policy.id}`);
    for (const name of ['AppFunction', 'WorkerFunction', 'SweeperFunction', 'PurgeFunction']) {
      expect(ids.some((id) => id.includes(name))).toBe(true);
    }
  });

  it('grants no wildcard actions to Pictora roles', () => {
    const wildcards = found
      .filter((policy) => !CDK_OWNED.some((pattern) => pattern.test(policy.id)))
      .flatMap((policy) =>
        policy.actions
          .filter((action) => action.includes('*'))
          .map((action) => `${policy.stack}/${policy.id}: ${action}`),
      );
    expect(wildcards).toEqual([]);
  });

  it('lets no role delete the table or a bucket', () => {
    const deletes = found.flatMap((policy) =>
      policy.actions
        .filter((pattern) => STATEFUL_DELETES.some((action) => grants(pattern, action)))
        .map((pattern) => `${policy.stack}/${policy.id}: ${pattern}`),
    );
    expect(deletes).toEqual([]);
  });

  it('matches IAM wildcards the way IAM does', () => {
    expect(grants('s3:*', 's3:DeleteBucket')).toBe(true);
    expect(grants('*', 'dynamodb:DeleteTable')).toBe(true);
    expect(grants('s3:Delete*', 's3:DeleteBucket')).toBe(true);
    expect(grants('s3:DeleteObject*', 's3:DeleteBucket')).toBe(false);
    expect(grants('dynamodb:DeleteItem', 'dynamodb:DeleteTable')).toBe(false);
  });
});
