# infra

AWS CDK app for Pictora. It holds the `PictoraDev` and `PictoraProd` stages, and the `PictoraCicd` stack.

`npx cdk synth` synthesises every stack without AWS credentials. `npm test -w infra` runs the CDK assertion tests.

## Stages

`PictoraDev` and `PictoraProd` are instances of `PictoraStage` (`lib/pictora_stage.ts`), each with these stacks:

| Stack         | Region    | Resources                                                                                                   |
| ------------- | --------- | ----------------------------------------------------------------------------------------------------------- |
| `Certificate` | us-east-1 | ACM certificate for the site domain, DNS-validated in the `rpillai.dev` zone. Only when a domain is set     |
| `Data`        | us-west-2 | DynamoDB table `pictora-<env>` and the images bucket                                                        |
| `Web`         | us-west-2 | App Lambda (image by digest) with a streaming Function URL, assets bucket, CloudFront, origin verify secret, DNS records |
| `Monitoring`  | us-west-2 | SNS alert topic, app 5xx alarm and the AWS budget                                                           |

### Settings

Per-environment settings live in `cdk.json` under `context.environments`: `domain` (prod has none yet, so it is served on its CloudFront domain), `dailyPoints`, `spendCapUsd`, `queueConcurrency`, `budgetUsd` and `appReservedConcurrency`.

Account-specific and per-deploy values are passed with `-c` and have placeholders, so synth works without them:

| Context          | Value                                                      | Placeholder                    |
| ---------------- | ---------------------------------------------------------- | ------------------------------ |
| `hostedZoneId`   | Route 53 zone ID of `rpillai.dev` (`vars.HOSTED_ZONE_ID`)  | `Z0000000000PLACEHOLDER`       |
| `appImageDigest` | Digest of the pushed `pictora-app` image                   | `sha256:000…`                  |
| `gitSha`         | Commit SHA, returned by `/api/health`                      | `local`                        |
| `appStaticDir`   | Next.js `.next/static` files from that image               | `app/.next/static`             |
| `appPublicDir`   | Next.js `public` folder from that image                    | `app/public`                   |
| `alertEmail`     | Email subscribed to the alert topic (kept out of the repo) | No subscription                |

With a real `appImageDigest`, synth fails unless `appStaticDir` exists, so a deploy never ships the app without its static files.

### Deploying a stage from a laptop

```sh
cd infra
scripts/extract_app_static.sh <account>.dkr.ecr.us-west-2.amazonaws.com/pictora-app@<digest> /tmp/pictora-static
npx cdk deploy 'PictoraDev/*' \
  -c hostedZoneId=<zone id> -c appImageDigest=<digest> -c gitSha=<sha> -c alertEmail=<email> \
  -c appStaticDir=/tmp/pictora-static/static -c appPublicDir=/tmp/pictora-static/public
```

The budget splits costs by the `environment` tag that every stage resource carries. Activate `environment` as a cost allocation tag once (Billing → Cost allocation tags) so the budget sees the costs.

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
