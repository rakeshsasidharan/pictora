import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { CicdStack } from '../lib/cicd_stack.js';
import { createPictoraApp, PRIMARY_REGION } from '../lib/pictora_app.js';

/** A placeholder account, so ARNs render as strings the assertions can read. */
const ACCOUNT = '111111111111';

interface Statement {
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Condition?: unknown;
}

let template: Template;

beforeAll(() => {
  const stack = new CicdStack(new App(), 'PictoraCicd', {
    env: { account: ACCOUNT, region: PRIMARY_REGION },
  });
  template = Template.fromStack(stack);
});

/** Renders `Fn::Join`s over literals and the partition as plain strings, so ARNs compare as text. */
function renderArns(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(renderArns);
  if (value === null || typeof value !== 'object') return value;
  const join = (value as Record<string, unknown>)['Fn::Join'] as [string, unknown[]] | undefined;
  if (join) {
    const parts = join[1].map((part) =>
      JSON.stringify(part) === JSON.stringify({ Ref: 'AWS::Partition' }) ? 'aws' : renderArns(part),
    );
    if (parts.every((part) => typeof part === 'string')) return parts.join(join[0]);
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, renderArns(entry)]));
}

function roleLogicalId(roleName: string): string {
  const roles = template.findResources('AWS::IAM::Role', { Properties: { RoleName: roleName } });
  const ids = Object.keys(roles);
  expect(ids).toHaveLength(1);
  return ids[0] ?? '';
}

function trustStatements(roleName: string): Statement[] {
  const role = template.toJSON().Resources[roleLogicalId(roleName)];
  return renderArns(role.Properties.AssumeRolePolicyDocument.Statement) as Statement[];
}

function policyStatements(roleName: string): Statement[] {
  const logicalId = roleLogicalId(roleName);
  const policies = template.findResources('AWS::IAM::Policy');
  return Object.values(policies)
    .filter(
      (policy) => JSON.stringify(policy.Properties.Roles) === JSON.stringify([{ Ref: logicalId }]),
    )
    .flatMap((policy) => renderArns(policy.Properties.PolicyDocument.Statement) as Statement[]);
}

function actions(statement: Statement): string[] {
  return Array.isArray(statement.Action) ? statement.Action : [statement.Action];
}

function resources(statement: Statement): unknown[] {
  return Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
}

function repositoryArnRefs(): unknown[] {
  return Object.keys(template.findResources('AWS::ECR::Repository')).map((id) => ({
    'Fn::GetAtt': [id, 'Arn'],
  }));
}

function bootstrapRoleArns(types: string[]): string[] {
  return types.flatMap((type) =>
    ['us-west-2', 'us-east-1'].map(
      (region) => `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-${type}-role-${ACCOUNT}-${region}`,
    ),
  );
}

describe('PictoraCicd stack', () => {
  it('is part of the CDK app, in the primary region', () => {
    const cicd = createPictoraApp().node.findChild('PictoraCicd') as CicdStack;
    expect(cicd).toBeInstanceOf(CicdStack);
    expect(cicd.region).toBe(PRIMARY_REGION);
  });

  it('imports the existing GitHub OIDC provider instead of creating one', () => {
    template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0);
    template.resourceCountIs('AWS::IAM::OIDCProvider', 0);
    for (const roleName of ['pictora-gh-diff', 'pictora-gh-build', 'pictora-gh-deploy']) {
      const [statement] = trustStatements(roleName);
      expect(JSON.stringify(statement)).toContain(
        `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`,
      );
    }
  });

  it.each([
    ['pictora-gh-diff', 'repo:rakeshsasidharan/pictora:pull_request'],
    ['pictora-gh-build', 'repo:rakeshsasidharan/pictora:ref:refs/heads/main'],
    [
      'pictora-gh-deploy',
      [
        'repo:rakeshsasidharan/pictora:environment:dev',
        'repo:rakeshsasidharan/pictora:environment:production',
      ],
    ],
  ])('trusts %s only for the expected sub and aud', (roleName, sub) => {
    const statements = trustStatements(roleName);
    expect(statements).toHaveLength(1);
    const [statement] = statements as [Statement];
    expect(statement.Effect).toBe('Allow');
    expect(statement.Action).toBe('sts:AssumeRoleWithWebIdentity');
    expect(statement.Condition).toEqual({
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': sub,
      },
    });
  });

  it('caps every role session at one hour', () => {
    template.resourcePropertiesCountIs('AWS::IAM::Role', { MaxSessionDuration: 3600 }, 3);
    template.resourceCountIs('AWS::IAM::Role', 3);
  });

  it('lets the diff role assume only the CDK bootstrap lookup roles', () => {
    expect(policyStatements('pictora-gh-diff')).toEqual([
      { Effect: 'Allow', Action: 'sts:AssumeRole', Resource: bootstrapRoleArns(['lookup']) },
    ]);
  });

  it('lets the build role reach only the two ECR repositories', () => {
    const statements = policyStatements('pictora-gh-build');
    const repositoryArns = repositoryArnRefs();
    expect(repositoryArns).toHaveLength(2);

    for (const statement of statements) {
      expect(statement.Effect).toBe('Allow');
      if (resources(statement).includes('*')) {
        expect(actions(statement)).toEqual(['ecr:GetAuthorizationToken']);
      } else {
        expect(actions(statement).every((action) => action.startsWith('ecr:'))).toBe(true);
        expect(resources(statement)).toEqual(repositoryArns);
      }
    }
    const repositoryActions = statements
      .filter((s) => !resources(s).includes('*'))
      .flatMap(actions);
    expect(repositoryActions).toEqual(
      expect.arrayContaining(['ecr:PutImage', 'ecr:BatchGetImage']),
    );
  });

  it('lets the deploy role assume only cdk-hnb659fds roles, and read ECR', () => {
    const statements = policyStatements('pictora-gh-deploy');
    const assume = statements.filter((statement) => actions(statement).includes('sts:AssumeRole'));
    expect(assume).toEqual([
      {
        Effect: 'Allow',
        Action: 'sts:AssumeRole',
        Resource: bootstrapRoleArns(['deploy', 'file-publishing', 'image-publishing', 'lookup']),
      },
    ]);
    for (const arn of assume.flatMap(resources)) {
      expect(arn).toMatch(new RegExp(`^arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-`));
    }

    const ecr = statements.filter((statement) => !actions(statement).includes('sts:AssumeRole'));
    const writes = [
      'ecr:PutImage',
      'ecr:InitiateLayerUpload',
      'ecr:UploadLayerPart',
      'ecr:CompleteLayerUpload',
    ];
    for (const statement of ecr) {
      expect(actions(statement).every((action) => action.startsWith('ecr:'))).toBe(true);
      expect(actions(statement).some((action) => writes.includes(action))).toBe(false);
    }
    expect(ecr.flatMap(actions)).toEqual(
      expect.arrayContaining(['ecr:BatchGetImage', 'ecr:DescribeImages']),
    );
  });

  it('gives no role wildcard actions or managed admin policies', () => {
    for (const role of Object.values(template.findResources('AWS::IAM::Role'))) {
      expect(role.Properties.ManagedPolicyArns).toBeUndefined();
    }
    for (const roleName of ['pictora-gh-diff', 'pictora-gh-build', 'pictora-gh-deploy']) {
      for (const statement of policyStatements(roleName)) {
        expect(actions(statement).some((action) => action.includes('*'))).toBe(false);
      }
    }
  });

  it.each(['pictora-app', 'pictora-worker'])(
    'creates the %s repository with immutable tags, scan on push and the lifecycle rule',
    (repositoryName) => {
      template.hasResource('AWS::ECR::Repository', {
        Properties: {
          RepositoryName: repositoryName,
          ImageTagMutability: 'IMMUTABLE',
          ImageScanningConfiguration: { ScanOnPush: true },
          LifecyclePolicy: {
            LifecyclePolicyText: Match.serializedJson({
              rules: [
                Match.objectLike({
                  selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: 50 },
                  action: { type: 'expire' },
                }),
              ],
            }),
          },
        },
        DeletionPolicy: 'Retain',
        UpdateReplacePolicy: 'Retain',
      });
    },
  );

  it('outputs the three role ARNs and both repository URIs', () => {
    expect(Object.keys(template.findOutputs('*')).sort()).toEqual([
      'AppRepositoryUri',
      'BuildRoleArn',
      'DeployRoleArn',
      'DiffRoleArn',
      'WorkerRepositoryUri',
    ]);
  });

  it('does not hard-code an account when synthesised without one', () => {
    const stack = new CicdStack(new App(), 'PictoraCicd', { env: { region: PRIMARY_REGION } });
    const json = JSON.stringify(Template.fromStack(stack).toJSON());
    expect(json).not.toMatch(/\d{12}/);
    expect(json).toContain('AWS::AccountId');
  });
});
