import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { Repository, TagMutability } from 'aws-cdk-lib/aws-ecr';
import {
  Effect,
  OpenIdConnectPrincipal,
  OpenIdConnectProvider,
  PolicyStatement,
  Role,
  type IOpenIdConnectProvider,
} from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

export const GITHUB_REPOSITORY = 'rakeshsasidharan/pictora';
export const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';
export const GITHUB_OIDC_AUDIENCE = 'sts.amazonaws.com';

/** Regions where CDK is bootstrapped: the app region and us-east-1 for CloudFront certificates. */
export const BOOTSTRAP_REGIONS = ['us-west-2', 'us-east-1'] as const;
export const BOOTSTRAP_QUALIFIER = 'hnb659fds';

export const ECR_REPOSITORY_NAMES = ['pictora-app', 'pictora-worker'] as const;
export const ECR_IMAGES_KEPT = 50;

/** Actions that read images from a repository. */
const ECR_READ_ACTIONS = [
  'ecr:BatchCheckLayerAvailability',
  'ecr:BatchGetImage',
  'ecr:DescribeImages',
  'ecr:DescribeRepositories',
  'ecr:GetDownloadUrlForLayer',
  'ecr:ListImages',
];

/** Actions that push images to a repository. */
const ECR_PUSH_ACTIONS = [
  'ecr:CompleteLayerUpload',
  'ecr:InitiateLayerUpload',
  'ecr:PutImage',
  'ecr:UploadLayerPart',
];

type BootstrapRoleType = 'deploy' | 'file-publishing' | 'image-publishing' | 'lookup';

/**
 * IAM roles GitHub Actions assumes through OIDC, and the shared ECR repositories (CI/CD design section 6).
 * Deployed once from a laptop with `npx cdk deploy PictoraCicd`; CI never changes it.
 */
export class CicdStack extends Stack {
  readonly diffRole: Role;
  readonly buildRole: Role;
  readonly deployRole: Role;
  readonly repositories: Repository[];

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const provider = OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GitHubOidcProvider',
      this.formatArn({
        service: 'iam',
        region: '',
        resource: 'oidc-provider',
        resourceName: GITHUB_OIDC_HOST,
      }),
    );

    this.repositories = ECR_REPOSITORY_NAMES.map(
      (repositoryName) =>
        new Repository(this, repositoryName, {
          repositoryName,
          imageTagMutability: TagMutability.IMMUTABLE,
          imageScanOnPush: true,
          lifecycleRules: [
            {
              description: `Keep the newest ${ECR_IMAGES_KEPT} images`,
              maxImageCount: ECR_IMAGES_KEPT,
            },
          ],
          removalPolicy: RemovalPolicy.RETAIN,
        }),
    );
    const repositoryArns = this.repositories.map((repository) => repository.repositoryArn);

    this.diffRole = this.githubRole(provider, 'DiffRole', 'pictora-gh-diff', ['pull_request']);
    this.diffRole.addToPolicy(this.assumeBootstrapRoles(['lookup']));

    this.buildRole = this.githubRole(provider, 'BuildRole', 'pictora-gh-build', [
      'ref:refs/heads/main',
    ]);
    this.buildRole.addToPolicy(ecrLoginStatement());
    this.buildRole.addToPolicy(
      new PolicyStatement({
        actions: [...ECR_READ_ACTIONS, ...ECR_PUSH_ACTIONS],
        resources: repositoryArns,
      }),
    );

    this.deployRole = this.githubRole(provider, 'DeployRole', 'pictora-gh-deploy', [
      'environment:dev',
      'environment:production',
    ]);
    this.deployRole.addToPolicy(
      this.assumeBootstrapRoles(['deploy', 'file-publishing', 'image-publishing', 'lookup']),
    );
    this.deployRole.addToPolicy(ecrLoginStatement());
    this.deployRole.addToPolicy(
      new PolicyStatement({ actions: ECR_READ_ACTIONS, resources: repositoryArns }),
    );

    new CfnOutput(this, 'DiffRoleArn', { value: this.diffRole.roleArn });
    new CfnOutput(this, 'BuildRoleArn', { value: this.buildRole.roleArn });
    new CfnOutput(this, 'DeployRoleArn', { value: this.deployRole.roleArn });
    const [appRepository, workerRepository] = this.repositories as [Repository, Repository];
    new CfnOutput(this, 'AppRepositoryUri', { value: appRepository.repositoryUri });
    new CfnOutput(this, 'WorkerRepositoryUri', { value: workerRepository.repositoryUri });
  }

  /** A role GitHub Actions can assume only from this repository, for the given token `sub` suffixes. */
  private githubRole(
    provider: IOpenIdConnectProvider,
    id: string,
    roleName: string,
    subjects: string[],
  ): Role {
    const sub = subjects.map((subject) => `repo:${GITHUB_REPOSITORY}:${subject}`);
    return new Role(this, id, {
      roleName,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new OpenIdConnectPrincipal(provider, {
        StringEquals: {
          [`${GITHUB_OIDC_HOST}:aud`]: GITHUB_OIDC_AUDIENCE,
          [`${GITHUB_OIDC_HOST}:sub`]: sub.length === 1 ? sub[0] : sub,
        },
      }),
    });
  }

  /** Permission to assume the given CDK bootstrap roles in every bootstrapped region. */
  private assumeBootstrapRoles(types: BootstrapRoleType[]): PolicyStatement {
    return new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['sts:AssumeRole'],
      resources: types.flatMap((type) =>
        BOOTSTRAP_REGIONS.map((region) =>
          this.formatArn({
            service: 'iam',
            region: '',
            resource: 'role',
            resourceName: `cdk-${BOOTSTRAP_QUALIFIER}-${type}-role-${this.account}-${region}`,
          }),
        ),
      ),
    });
  }
}

/** `docker login` to ECR needs an authorization token, which IAM only grants on `*`; it opens no repository. */
function ecrLoginStatement(): PolicyStatement {
  return new PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] });
}
