# infra

AWS CDK app for Pictora. It holds the `PictoraDev` and `PictoraProd` stages, and the `PictoraCicd` stack.

`npx cdk synth` synthesises every stack without AWS credentials. `npm test -w infra` runs the CDK assertion tests.

## PictoraCicd

`PictoraCicd` (us-west-2) holds what GitHub Actions needs to reach AWS (CI/CD design, section 6):

| Resource            | Purpose                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pictora-gh-diff`   | Assumed by pull requests; can assume the CDK bootstrap lookup roles for `cdk diff`                                 |
| `pictora-gh-build`  | Assumed by pushes to `main`; can push and pull on the two ECR repositories only                                    |
| `pictora-gh-deploy` | Assumed from the `dev` and `production` environments; can assume the CDK bootstrap roles in us-west-2 and us-east-1 |
| `pictora-app`       | ECR repository for the app image: immutable tags, scan on push, newest 50 images kept                              |
| `pictora-worker`    | ECR repository for the worker image, with the same settings                                                        |

The roles trust the GitHub OIDC provider that already exists in the account; the stack imports it and does not create one. The account ID comes from your credentials, so nothing account-specific is committed.

### Deploying

Deploy it once from a laptop, with admin credentials for the Pictora account. CI never deploys it.

```sh
cd infra
npx cdk deploy PictoraCicd
```

Then copy the stack outputs into repository variables (Settings → Secrets and variables → Actions → Variables):

| Variable             | Value                    |
| -------------------- | ------------------------ |
| `AWS_DIFF_ROLE_ARN`  | `DiffRoleArn` output     |
| `AWS_BUILD_ROLE_ARN` | `BuildRoleArn` output    |
| `AWS_DEPLOY_ROLE_ARN`| `DeployRoleArn` output   |
| `AWS_ACCOUNT_ID`     | The AWS account ID       |
| `AWS_REGION`         | `us-west-2`              |

The ECR repositories are retained if the stack is deleted.
