# Pictora CI/CD Design

Oct 8, 2026 · Rakesh Pillai · Status: Draft v0.1 · Companion to the [tech design](tech_design.md)

Every pull request is checked automatically. Every merge to `main` builds once, deploys to dev, runs end-to-end tests, then waits for your approval to promote **the same images** to prod. GitHub Actions authenticates to AWS with OIDC, so no AWS keys are stored anywhere.

## 1. Goals

1. No untested code reaches `main`: lint, type checks, unit and infra tests on every PR.
2. Build once, promote the same artifact: prod runs the exact container digests that passed in dev.
3. A human gate before prod, with a one-click rollback to any earlier commit.
4. No long-lived credentials: OIDC to AWS; provider API keys stay in AWS Secrets Manager.
5. Fast feedback: PR checks in under 8 minutes, merge to dev in under 20 minutes.
6. Safe for a public repo: forks can't reach AWS or secrets.

## 2. Context

| Fact | Effect on the design |
| --- | --- |
| The repo `rakeshsasidharan/pictora` is **public** | Free GitHub-hosted runners, including arm64 (`ubuntu-24.04-arm`); environments with required reviewers are available; fork PRs need guarding; never commit account IDs, domains in config, or secrets |
| The GitHub OIDC provider already exists in the AWS account | Reuse it; only new IAM roles are needed |
| CDK is bootstrapped in us-west-2 and us-east-1 | CI assumes the standard `cdk-hnb659fds-*` bootstrap roles |
| dev and prod are in one AWS account | Simpler, but a dev deploy role could in theory change prod stacks (see section 8) |
| Branch-per-issue workflow (`<issue>-<slug>`), PRs created and merged by you | PR checks are the main quality gate; `main` is always deployable |
| `.github/workflows/app.yml` was copied from Hermes | It points at Hermes resources and an `app/` folder that doesn't exist yet. **Delete it** when these workflows land |

## 3. Pipeline overview

```mermaid
flowchart LR
    subgraph PR["Pull request → main"]
        direction TB
        C1[checks<br/>lint · types · tests · build · synth]
        C2[image build check<br/>arm64, no push]
        C3[cdk diff<br/>dev + prod, posted as a PR comment]
        C1 --> C3
    end

    subgraph Main["Push to main"]
        direction TB
        M1[checks] --> M2[build images<br/>app + worker, arm64<br/>push to ECR by commit SHA]
        M2 --> M3[deploy dev<br/>cdk deploy PictoraDev/*]
        M3 --> M4[e2e on dev<br/>Playwright, mock provider]
        M4 --> M5{approve<br/>production}
        M5 --> M6[deploy prod<br/>same image digests]
        M6 --> M7[smoke test prod<br/>/api/health returns the SHA]
    end

    PR -- "merge" --> Main
    R[Manual run: redeploy or roll back<br/>env + commit SHA] --> M3
    R --> M6
```

## 4. Workflows

| File | Trigger | Jobs | Purpose |
| --- | --- | --- | --- |
| `.github/workflows/checks.yml` | `workflow_call` (reusable) | `checks` | One definition of lint, typecheck, tests, build and synth, used by both pipelines |
| `.github/workflows/pr.yml` | `pull_request` → `main` | `changes`, `checks`, `image-build`, `image-check`, `cdk-diff` | PR gate |
| `.github/workflows/deploy.yml` | `push` → `main`; `workflow_dispatch` (environment, commit SHA) | `checks`, `build-images`, `resolve`, `deploy-dev`, `e2e-dev`, `deploy-prod`, `smoke-prod` | Build once, deploy dev, promote to prod; also used for redeploys and rollbacks |
| `.github/dependabot.yml` | Weekly | — | npm (grouped minor and patch), GitHub Actions, Docker base images |

Docs-only changes (`docs/**`, `**/*.md`) skip `deploy.yml` through `paths-ignore`. On PRs, the `changes` job uses `dorny/paths-filter` to skip the image check when only docs or infra changed.

### 4.1 `checks` (reusable)

Runs on `ubuntu-24.04-arm` with Node 22 and the npm cache.

1. `npm ci` (one root lockfile; npm workspaces).
2. `npm run lint` (ESLint across workspaces) and `npm run format:check` (Prettier).
3. `npm run typecheck` (`tsc --noEmit` per workspace).
4. `npm test`, which runs Vitest in every workspace. DynamoDB Local runs as a job service container (`amazon/dynamodb-local`) for the API and worker tests.
5. `npm run build`, which builds every workspace in dependency order, including the Next.js build of `app` (catches build-only errors).
6. `npx cdk synth` with dummy image digests (the CLI synthesises every stack and ignores `--all` for synth). The CDK assertion tests run in step 4.
7. `npm audit --omit=dev --audit-level=high`, which fails the build on high or critical issues in runtime dependencies.

Target: under 6 minutes.

### 4.2 `pr.yml`

| Job | Runs when | Details |
| --- | --- | --- |
| `changes` | Always | Outputs `app`, `worker`, `packages`, `infra` flags |
| `checks` | Always | Calls `checks.yml` |
| `image-build` | app, worker or packages changed | `docker buildx build` of both images on arm64, no push (matrix: `app`, `worker`). Catches Dockerfile breaks before merge |
| `image-check` | Always | Passes when `image-build` passed or was skipped. A skipped matrix job doesn't report its per-image check names, so this job gives the ruleset one check that is always present |
| `cdk-diff` | infra or packages changed, **and the PR is from this repo, not a fork** | OIDC → `pictora-gh-diff` role → `cdk diff 'PictoraDev/*' 'PictoraProd/*'`. Posts or updates one PR comment headed `## CDK Diff` |

Guard for fork PRs: `if: github.event.pull_request.head.repo.full_name == github.repository`. Never use `pull_request_target`.

### 4.3 `deploy.yml`

```yaml
name: Deploy
on:
  push:
    branches: [main]
    paths-ignore: ['docs/**', '**/*.md']
  workflow_dispatch:
    inputs:
      environment: { type: choice, options: [dev, production], required: true }
      sha: { description: 'Commit SHA to deploy (already built)', required: true }

concurrency:
  group: deploy-${{ github.event_name == 'workflow_dispatch' && inputs.environment || 'pipeline' }}
  cancel-in-progress: false

permissions:
  contents: read
  id-token: write

jobs:
  checks:            # push only
  build-images:      # push only; matrix [app, worker]; runs-on ubuntu-24.04-arm
                     # OIDC → pictora-gh-build → ECR login → buildx --platform linux/arm64
                     # tags <sha>; the digests go to the job summary
  resolve:           # push (after build-images) and manual runs: reads the digests of the
                     # images tagged <sha> from ECR; outputs sha, app_digest, worker_digest
  deploy-dev:        # environment: dev; needs resolve
                     # OIDC → pictora-gh-deploy → cdk deploy 'PictoraDev/*'
                     #   -c appImageDigest=… -c workerImageDigest=… -c gitSha=…
  e2e-dev:           # environment: dev; Playwright against the dev URL
  deploy-prod:       # environment: production (required reviewer); needs e2e-dev
                     # same digests from resolve outputs
  smoke-prod:        # curl https://<prod>/api/health and check that sha == github.sha
```

**Details**

- **Images:** two ECR repositories, `pictora-app` and `pictora-worker`, with **immutable tags** and scan on push. Tag = full commit SHA. CDK references images **by digest** (`DockerImageCode.fromEcr(repo, { tagOrDigest: digest })`), so a deploy is reproducible.
- **Build cache:** `docker/build-push-action` with `cache-from/cache-to: type=gha,scope=<image>`, which keeps rebuilds to about 1–2 minutes.
- **CDK:** stages `PictoraDev` and `PictoraProd`. Deploy command: `npx cdk deploy '<Stage>/*' --require-approval never --concurrency 3 --outputs-file cdk-outputs.json`. The outputs file gives `e2e-dev` the site URL.
- **Promotion:** `deploy-prod` uses `needs.resolve.outputs`. Tags are immutable, so the digests `resolve` reads for the commit are exactly the images `build-images` pushed, and one lookup serves both the pipeline and manual runs (a matrix job can't reliably output a value per leg). Nothing is rebuilt, so prod runs exactly what passed e2e in dev.
- **Scripts:** `.github/scripts/resolve_images.sh` (digest lookup), `deploy_stage.sh` (extract static files from the app image, `cdk deploy`, read `SiteUrl` from the outputs) and `smoke_test.sh` (`/api/health` returns `status: ok` and the expected `sha`, with retries). Deploy jobs check out the commit being deployed, and take the scripts from the workflow's own commit.
- **e2e:** `e2e-dev` runs `npm run e2e --workspace=@pictora/e2e` with `E2E_BASE_URL`, `E2E_USER_EMAIL` and `E2E_USER_PASSWORD`, and uploads `e2e/test-results` and `e2e/playwright-report` on failure. It skips with a notice while the workspace has no `e2e` script. `deploy-dev` also runs the smoke test, so a dev rollback is checked even without e2e.
- **Approval:** the `production` environment has you as the required reviewer. The run pauses with a "Review deployments" button. Prod waits until you approve, and an unapproved run expires after 30 days.
- **Version check:** CDK passes `GIT_SHA` to the app Lambda. `/api/health` returns `{ status: 'ok', sha }`, and the smoke test checks it.
- **Run time:** checks 6 min + build 3 min + dev deploy 5 min + e2e 4 min ≈ **18 minutes to dev**; prod adds about 6 minutes after approval.

### 4.4 Redeploy and rollback

Run **Deploy → Run workflow**, pick `environment` and `sha`.

1. The `resolve` job checks that both images exist in ECR with that tag (`aws ecr describe-images`) and reads their digests; the worker image is required only if that commit has `worker/Dockerfile`. If they're missing, it fails with a message to build that commit first. It uses the build role, which can read ECR from `main`.
2. It checks out **that SHA**, so infrastructure rolls back too, then deploys only the chosen environment.
3. It runs the smoke test (prod) or e2e (dev).

**Rules that keep rollback safe**

- DynamoDB changes must be additive: new attributes or entities only, and readers must handle missing fields. Never rename or reuse a key format within one release.
- Never remove a resource and the code using it in the same release; remove the code first, then the resource in a later release.
- The model registry seed keeps `enabled` flags already in DynamoDB, so a rollback doesn't re-enable a model you switched off.
- Stateful prod resources (table, images bucket, user pool) have `RemovalPolicy.RETAIN`.

## 5. Environments and configuration

### 5.1 GitHub environments

| Environment | Protection | Deployment branches | Variables | Secrets |
| --- | --- | --- | --- | --- |
| `dev` | None | `main` only | `SITE_URL` (`https://pictora.rpillai.dev`) | `E2E_USER_PASSWORD` (Cognito test user) |
| `production` | Required reviewer: `rakeshsasidharan` (self-review allowed) | `main` only | None (the smoke test reads the site URL from the stack outputs) | None |

Repository variables (not secrets; kept out of code so the public repo holds no account details): `AWS_ACCOUNT_ID`, `AWS_REGION` (`us-west-2`), `AWS_BUILD_ROLE_ARN`, `AWS_DEPLOY_ROLE_ARN`, `AWS_DIFF_ROLE_ARN`, `HOSTED_ZONE_ID` (Route 53 zone of `rpillai.dev`), `ALERT_EMAIL` (SNS alarm and budget alerts), `E2E_USER_EMAIL`.

Per-environment app settings (daily points, spend cap, queue concurrency, domain) live in CDK context in `infra/cdk.json`. A domain name is public anyway, so it can live there once chosen.

### 5.2 What lives where

| Item | Location | Who sets it |
| --- | --- | --- |
| OpenAI and Gemini keys | AWS Secrets Manager `pictora/<env>/…` | You, once per environment, via console or CLI |
| AWS access for CI | OIDC roles; ARNs in repository variables | `PictoraCicd` stack |
| e2e test user password | `dev` environment secret | You |
| Image digests | Job outputs (pipeline) or ECR lookup (rollback) | Pipeline |

## 6. AWS IAM for CI (the `PictoraCicd` stack)

A small CDK stack, `PictoraCicd`, holds everything CI needs. **You deploy it once from your laptop** (`npx cdk deploy PictoraCicd`); after that, CI never changes it. It imports the existing GitHub OIDC provider by ARN.

| Role | Trusted when the token `sub` is | Can do |
| --- | --- | --- |
| `pictora-gh-diff` | `repo:rakeshsasidharan@16108001/pictora@1409752771:pull_request` | Assume the CDK bootstrap **lookup** role (read-only), for `cdk diff` |
| `pictora-gh-build` | `repo:rakeshsasidharan@16108001/pictora@1409752771:ref:refs/heads/main` | Push and read on `pictora-app` and `pictora-worker` ECR repos only |
| `pictora-gh-deploy` | `repo:rakeshsasidharan@16108001/pictora@1409752771:environment:dev` or `…:environment:production` | Assume the CDK bootstrap deploy, file-publishing, image-publishing and lookup roles in us-west-2 and us-east-1; read ECR images |

The repository uses GitHub's immutable OIDC subjects, so `sub` names the owner and repository by their numeric IDs (`owner@id/repo@id`). A renamed or re-created repository with the same name can't assume the roles.

All roles require `aud = sts.amazonaws.com`, a 1-hour maximum session, and no inline admin rights. The deploy role is trusted **only from GitHub environments**, and environments accept only `main`, so a feature branch can never deploy.

The stack also creates the two ECR repositories: immutable tags, scan on push, and a lifecycle rule keeping the newest 50 images. That's enough for rollbacks across several weeks of merges.

## 7. Repository settings

| Setting | Value |
| --- | --- |
| Ruleset on `main` | Require a pull request (0 approvals; you are the only maintainer); require status checks `checks / checks` and `image-check` from GitHub Actions; block force pushes and deletion; **empty bypass list**, so nobody (including the Claude Code routine, which pushes as a repo admin) can push to `main` directly |
| Actions → Fork PR workflows | Require approval for all outside contributors |
| Actions → Workflow permissions | Read-only `GITHUB_TOKEN` by default; workflows ask for more per job |
| Secret scanning + push protection | On (free for public repos) |
| CodeQL | Default setup on, for JavaScript/TypeScript (free for public repos) |
| Dependabot alerts + security updates | On |
| Action pinning | Major versions (`@v4`), kept current by Dependabot; third-party actions (`dorny/paths-filter`) pinned to a commit SHA |

### 7.1 Applying the settings

The settings are applied with `gh api` (as a repo admin) and can be re-run at any time; each command sets the full state. The ruleset itself is kept in [`.github/rulesets/protect_main.json`](../.github/rulesets/protect_main.json). `15368` is the GitHub Actions app ID, so only check runs from Actions can satisfy the required checks.

```sh
REPO=rakeshsasidharan/pictora

# Ruleset on main: update the existing "Protect main" ruleset, or create it if it doesn't exist yet.
RULESET_ID=$(gh api "repos/$REPO/rulesets" --jq '.[] | select(.name == "Protect main") | .id')
if [ -n "$RULESET_ID" ]; then
  gh api -X PUT "repos/$REPO/rulesets/$RULESET_ID" --input .github/rulesets/protect_main.json
else
  gh api -X POST "repos/$REPO/rulesets" --input .github/rulesets/protect_main.json
fi

# Actions: approval for every outside contributor's fork PR runs; read-only GITHUB_TOKEN by default.
gh api -X PUT "repos/$REPO/actions/permissions/fork-pr-contributor-approval" \
  -f approval_policy=all_external_contributors
gh api -X PUT "repos/$REPO/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false

# Secret scanning with push protection.
gh api -X PATCH "repos/$REPO" --input - <<'JSON'
{"security_and_analysis": {"secret_scanning": {"status": "enabled"}, "secret_scanning_push_protection": {"status": "enabled"}}}
JSON

# Dependabot alerts and security updates.
gh api -X PUT "repos/$REPO/vulnerability-alerts"
gh api -X PUT "repos/$REPO/automated-security-fixes"

# CodeQL default setup for JavaScript/TypeScript.
gh api -X PATCH "repos/$REPO/code-scanning/default-setup" \
  -f state=configured -f query_suite=default -f 'languages[]=javascript-typescript'
```

To check the result:

```sh
gh api "repos/$REPO/rulesets/$RULESET_ID" --jq '{bypass_actors, rules: [.rules[].type]}'
gh api "repos/$REPO/actions/permissions/workflow"
gh api "repos/$REPO/actions/permissions/fork-pr-contributor-approval"
gh api "repos/$REPO" --jq '.security_and_analysis'
gh api "repos/$REPO/vulnerability-alerts" --silent && echo 'Dependabot alerts on'
gh api "repos/$REPO/automated-security-fixes"
gh api "repos/$REPO/code-scanning/default-setup"
```

## 8. Risks and trade-offs

| Risk | Mitigation now | Later option |
| --- | --- | --- |
| dev and prod in one account: CDK deploy roles can change any stack | Deploy role trusted only from protected environments on `main`; prod stacks retain stateful data; PITR and S3 versioning in prod | Move prod to its own AWS account in your organisation; bootstrap with a trust policy for the CI account |
| CDK bootstrap execution role is broad (default admin) | Accepted for a solo project; all changes go through PR review and `cdk diff` | Bootstrap with a custom, narrower `--cloudformation-execution-policies` |
| Fork PRs in a public repo | No OIDC or secrets for forks; no `pull_request_target`; approval required for outside contributors' runs | — |
| e2e depends on a live dev stack | Mock provider (no spend); 2 retries in Playwright for flaky network steps; failures block prod | Add a preview environment per PR if needed |
| A failed prod deploy leaves the app half-updated | CloudFormation rolls back the failed stack automatically; rerun with the previous SHA | Lambda aliases with CodeDeploy canary (10% for 5 minutes) on the app and worker |

## 9. Setup order

These steps fit M0 (Oct 9–10). Each becomes a GitHub issue with tests where they apply.

1. Create the npm workspaces skeleton with `lint`, `typecheck`, `test` and `build` scripts.
2. Write the `PictoraCicd` stack and deploy it from your laptop; copy the role ARNs into repository variables.
3. Create the `dev` and `production` GitHub environments (section 5.1).
4. Add `checks.yml` and `pr.yml`, and delete the Hermes `app.yml`.
5. Add `deploy.yml` with dev only; once dev deploys work, add `e2e-dev`, `deploy-prod` and `smoke-prod`.
6. Turn on the `main` ruleset, secret scanning, CodeQL and Dependabot (section 7).
7. Store provider keys in Secrets Manager for both environments.
8. Do a dry-run rollback in dev to prove the manual path.
