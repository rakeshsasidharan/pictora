# e2e

Playwright end-to-end suite for Pictora (tech design 13). The deploy pipeline runs it against dev after every dev deploy, and prod is deployed only when it passes (CI/CD design 4.3). It runs Chromium only, retries a failed test twice and keeps traces and screenshots of failures.

It never runs against prod: `src/config.ts` refuses the prod domain from `infra/cdk.json`, and any host other than the dev domain or `localhost`, because prod is served on its CloudFront domain until it has a domain of its own.

## Layout

| Path                     | What                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `playwright.config.ts`   | Projects, retries, traces and the four-minute budget                                       |
| `specs/sign_in.setup.ts` | The `setup` project: signs the test user in once and saves the session to `.auth/user.json` |
| `specs/*.spec.ts`        | The `chromium` project, which reuses that session                                          |
| `src/`                   | Settings and the prod guard, the managed login helper and issue links                      |
| `test/`                  | Vitest unit tests for `src/`, run by `npm test`                                            |

`health` and `auth` run today. `generate`, `edit`, `gallery`, `delete` and `landing` are placeholders marked `test.fixme`, each linked to the issue that makes it pass (#18, #22, #23 and #29). They use the mock provider, which only dev offers.

## Settings

| Variable            | Value                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------- |
| `E2E_BASE_URL`      | Site under test. Falls back to `BASE_URL`, then `SITE_URL`, then `https://<dev domain>` |
| `E2E_USER_EMAIL`    | Email of the Cognito test user                                                          |
| `E2E_USER_PASSWORD` | Its password                                                                            |

In CI, `E2E_BASE_URL` comes from the `dev` environment's `SITE_URL` variable (or the deployed site URL), `E2E_USER_EMAIL` from the repository variable of that name and `E2E_USER_PASSWORD` from the `dev` environment secret of that name.

## Running locally

Chromium has to be installed once:

```sh
cd e2e
npx playwright install chromium
```

Then, from the repo root, run the suite against dev:

```sh
E2E_USER_EMAIL=... E2E_USER_PASSWORD=... npm run test:e2e -w e2e
```

`npm run e2e -w e2e` is the same command; the pipeline uses that name. Add Playwright options after `--`, for example `-- --ui` or `-- specs/health.spec.ts`. `npx playwright show-report` opens the last HTML report, and `npx playwright show-trace test-results/<test>/trace.zip` opens a failure's trace.

A local server (`E2E_BASE_URL=http://localhost:3000`) runs `health`, but sign-in needs a Cognito app client, so the other tests need dev.

## The test user

The suite signs in as a dedicated email and password user in the dev user pool, created once by hand. It must never be an admin, and it exists only in dev.

1. Create the user with a permanent password, using an address you control (the AWS profile needs access to the dev account):

   ```sh
   POOL_ID=$(aws cognito-idp list-user-pools --max-results 60 --region us-west-2 \
     --query "UserPools[?Name=='pictora-dev'].Id" --output text)
   aws cognito-idp admin-create-user --region us-west-2 --user-pool-id "$POOL_ID" \
     --username "$E2E_USER_EMAIL" --message-action SUPPRESS \
     --user-attributes Name=email,Value="$E2E_USER_EMAIL" Name=email_verified,Value=true
   aws cognito-idp admin-set-user-password --region us-west-2 --user-pool-id "$POOL_ID" \
     --username "$E2E_USER_EMAIL" --password "$E2E_USER_PASSWORD" --permanent
   ```

2. Save the email as the repository variable `E2E_USER_EMAIL` and the password as the `dev` environment secret `E2E_USER_PASSWORD`:

   ```sh
   gh variable set E2E_USER_EMAIL --body "$E2E_USER_EMAIL"
   gh secret set E2E_USER_PASSWORD --env dev --body "$E2E_USER_PASSWORD"
   ```

3. Sign in once at https://pictora.rpillai.dev with it to check that it works.

To rotate the password, run step 1's `admin-set-user-password` with a new one and update the secret.

## Failures in CI

When the suite fails, the `e2e-dev` job uploads `e2e/test-results` (traces and screenshots) and `e2e/playwright-report` as the `e2e-results` artifact, kept for 7 days. The setup project records no trace, so the password never lands in one, but test traces include the test user's session cookies; the short retention limits how long they can be downloaded. The saved session in `.auth/` is never uploaded.
