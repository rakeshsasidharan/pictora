# Pictora runbook

How to operate Pictora in production: deploys, incidents, user and model actions, and the launch drills (#33). Commands use the AWS CLI with an admin profile in `us-west-2`. Replace `<env>` with `prod` or `dev`. The everyday DynamoDB commands are in the [README](../README.md#operations), and this runbook links to them.

| | Dev | Prod |
| --- | --- | --- |
| Site | https://dev.pictora.rpillai.dev | https://pictora.rpillai.dev |
| Table | `pictora-dev` | `pictora-prod` |
| Alarm topic | `pictora-dev-alerts` | `pictora-prod-alerts` (emails `ALERT_EMAIL`) |
| Dashboard | CloudWatch `pictora-dev` | CloudWatch `pictora-prod` |
| Admin pages | `/admin` | `/admin` |

Find a user pool ID with `aws cognito-idp list-user-pools --max-results 20 --query "UserPools[?Name=='pictora-<env>'].Id" --output text`.

## Deploy and rollback

- **Normal deploys:** every merge to `main` builds once, deploys dev, runs e2e on dev, then waits for approval. Approve the run's **Review deployments** button to promote the same images to prod; the smoke test then checks `/api/health`.
- **What's live:** `curl -s https://pictora.rpillai.dev/api/health` shows the released commit SHA.
- **Rollback or redeploy:** pick the last good SHA (from `/api/health` before the bad release, or the commit list on `main`), then run the Deploy workflow for that SHA. It needs the SHA's images in ECR, so the commit must have been built by a push to `main`:

  ```sh
  gh workflow run deploy.yml -f environment=production -f sha=<full commit sha>
  ```

  The run deploys only that environment, with that commit's infrastructure, and runs the smoke test (prod) or e2e (dev). Releases keep DynamoDB changes additive, so a rollback reads newer items safely ([CI/CD design 4.4](cicd_design.md)).
- **After a rollback:** fix forward on `main`; the next merge deploys normally.

## Kill a model

When a model misbehaves, costs too much or its provider is down, set `enabled` to false on its registry item ([README: Switching a model off](../README.md#switching-a-model-off-adm-2)):

```sh
aws dynamodb update-item --region us-west-2 --table-name pictora-prod \
  --key '{"PK":{"S":"MODEL#<model id>"},"SK":{"S":"CONFIG"}}' \
  --update-expression 'SET enabled = :off' \
  --expression-attribute-values '{":off":{"BOOL":false}}'
```

It leaves the app within 60 seconds, and stays off after later deploys. Auto routes to the next model for each style, and users whose saved defaults name it get Auto, with a notice. Set `:off` to `true` to switch it back on.

## Override a user's points

Set `dailyPoints` on the user's profile; it applies from their next request ([README: Overriding a user's daily points](../README.md#overriding-a-users-daily-points-adm-5)):

```sh
aws dynamodb update-item --region us-west-2 --table-name pictora-prod \
  --key '{"PK":{"S":"USER#<sub>"},"SK":{"S":"PROFILE"}}' \
  --update-expression 'SET dailyPoints = :points' \
  --expression-attribute-values '{":points":{"N":"100"}}'
```

`REMOVE dailyPoints` restores the default. The `sub` is in the Cognito console, or on `/admin` in the top users table.

## Suspend a user

On `/admin/users/<sub>`, choose **Suspend** and confirm. From the next request, their job, enhance and upload requests answer 403. The action is logged in the moderation log with your `sub`. **Unsuspend** on the same page reverses it.

Suspension doesn't sign them out or stop jobs already running. For a serious case, also disable their Cognito user:

```sh
aws cognito-idp admin-disable-user --region us-west-2 --user-pool-id <pool id> --username <username>
aws cognito-idp admin-user-global-sign-out --region us-west-2 --user-pool-id <pool id> --username <username>
```

## Respond to a spend alarm

The `pictora-prod-spend-80` and `pictora-prod-spend-100` alarms, and the AWS budget at 50%, 80% and 100% of $100, email `ALERT_EMAIL`.

1. Open the `pictora-prod` dashboard: spend today and this month, and which provider drives it.
2. Open `/admin` for the top users by spend today. One user far above the rest: suspend them, or lower their `dailyPoints`.
3. One model far above the rest: kill it, or keep it and accept the cost.
4. At 100% the app already allows Draft quality only until the 1st of next month (UTC). Raising the cap is a change to `spendCapUsd` in `infra/cdk.json` and a deploy. Match the OpenAI and Google billing alerts if you do.
5. Check the provider consoles (OpenAI usage, Google AI Studio billing) for spend the app didn't count.

## Respond to a provider outage

Signs: `pictora-prod-model-health`, `pictora-prod-<provider>-p95-latency`, `pictora-prod-failure-rate` or `pictora-prod-<provider>-oldest-message` alarms, and failed jobs with provider errors.

1. Confirm on the provider's status page (status.openai.com, aistudio.google.com/status).
2. Kill the provider's models (above), so Auto and the pickers use the other provider. Failed jobs are refunded automatically.
3. Jobs stuck in the provider's queue are failed and refunded by the sweeper after 10 minutes queued or 5 minutes running.
4. When the provider recovers, switch the models back on and watch the model health alarm return to OK.

## Redrive the dead-letter queue

The `pictora-prod-dlq` alarm fires when a message failed 3 times. The DLQ `pictora-prod-dlq` holds messages from every provider queue and the purge queue for 14 days.

1. Look at the messages, without removing them:

   ```sh
   url=$(aws sqs get-queue-url --region us-west-2 --queue-name pictora-prod-dlq --query QueueUrl --output text)
   aws sqs receive-message --region us-west-2 --queue-url "$url" --max-number-of-messages 10 --visibility-timeout 0
   ```

2. Find the cause in the worker's logs (CloudWatch Logs Insights on the worker log group, filtered on the `jobId` or `sub` in the message). Fix it first, by deploying or killing a model, or the messages fail again.
3. Move them back to their source queues:

   ```sh
   arn=$(aws sqs get-queue-attributes --region us-west-2 --queue-url "$url" --attribute-names QueueArn --query Attributes.QueueArn --output text)
   aws sqs start-message-move-task --region us-west-2 --source-arn "$arn"
   ```

Redriving is safe. The worker only runs a job that is still `queued`, so a job the sweeper already failed and refunded is skipped. The account purge skips what is already deleted.

## Handle a takedown or abuse report

User reports land on `/admin/moderation`, for the day they were made, with a thumbnail.

1. Review the entry: **OK** when nothing is wrong, **Confirmed** when it breaks the [content policy](../app/content/legal/content_policy.md).
2. For a confirmed case, suspend the user (above). Content involving minors means terminating the account: disable it in Cognito, then report as the law requires.
3. To take an image down, delete its objects and items. The `imageId` and the owner's `sub` are on the moderation entry:

   ```sh
   aws s3 rm --recursive "s3://pictora-prod-images-<account id>/users/<sub>/<imageId>/"
   aws dynamodb query --region us-west-2 --table-name pictora-prod \
     --key-condition-expression 'PK = :pk AND begins_with(SK, :ver)' \
     --expression-attribute-values '{":pk":{"S":"USER#<sub>"},":ver":{"S":"VER#<imageId>#"}}' \
     --query 'Items[].SK.S' --output text
   # Delete each VER#<imageId>#<n> listed, then the image item:
   aws dynamodb delete-item --region us-west-2 --table-name pictora-prod \
     --key '{"PK":{"S":"USER#<sub>"},"SK":{"S":"IMG#<imageId>"}}'
   ```

4. For an outside takedown request (email to the contact address), find the image the same way, take it down, and reply from the contact address.

## Rotate a provider key

1. Create the new key in the provider's console (OpenAI API keys, or Google AI Studio for Gemini).
2. Store it. The secret holds the key as plain text:

   ```sh
   aws secretsmanager put-secret-value --region us-west-2 --secret-id pictora/prod/openai --secret-string '<new key>'
   ```

3. The app and worker cache secrets for 5 minutes, so the new key is in use within 5 minutes, with no deploy. Run `npm run check:providers` with an admin profile to confirm it works.
4. Revoke the old key in the provider's console after 10 minutes.

The Google sign-in secret `pictora/prod/google-oauth` (`{ clientId, clientSecret }`) is read by CloudFormation at deploy time. After changing it, redeploy prod (Deploy workflow, production, the live SHA) before revoking the old client secret.

## Launch drills (#33)

Do each on prod before turning off beta mode, and tick it in the launch checklist on issue #33.

### Test the alarms

1. Confirm the email subscription: the topic needs a confirmed subscriber.

   ```sh
   topic=$(aws sns list-topics --region us-west-2 --query "Topics[?ends_with(TopicArn, ':pictora-prod-alerts')].TopicArn" --output text)
   aws sns list-subscriptions-by-topic --region us-west-2 --topic-arn "$topic"
   ```

   No subscriber means `ALERT_EMAIL` wasn't set when prod last deployed: set it and deploy. `PendingConfirmation` means the email from AWS hasn't been confirmed yet.
2. Force an alarm into ALARM. It returns to its real state at the next evaluation, within minutes:

   ```sh
   aws cloudwatch set-alarm-state --region us-west-2 --alarm-name pictora-prod-dlq \
     --state-value ALARM --state-reason 'Launch drill: testing alarm emails'
   ```

3. Check that the alarm email arrives at `ALERT_EMAIL`, then the OK email when it recovers.

### Restore a backup (point-in-time recovery)

`pictora-prod` has point-in-time recovery on, with 35 days of history.

1. Restore to a temporary table from 10 minutes ago:

   ```sh
   aws dynamodb restore-table-to-point-in-time --region us-west-2 \
     --source-table-name pictora-prod --target-table-name pictora-prod-restore-drill \
     --restore-date-time "$(date -u -v-10M +%Y-%m-%dT%H:%M:%SZ)"
   ```

   (On Linux, use `date -u -d '10 minutes ago' +%Y-%m-%dT%H:%M:%SZ`.)
2. Wait until it is `ACTIVE`, which takes a few minutes or longer for a big table:

   ```sh
   aws dynamodb wait table-exists --region us-west-2 --table-name pictora-prod-restore-drill
   ```

3. Compare item counts, and read one known item, such as your profile:

   ```sh
   for t in pictora-prod pictora-prod-restore-drill; do
     aws dynamodb scan --region us-west-2 --table-name "$t" --select COUNT --query Count
   done
   aws dynamodb get-item --region us-west-2 --table-name pictora-prod-restore-drill \
     --key '{"PK":{"S":"USER#<your sub>"},"SK":{"S":"PROFILE"}}'
   ```

   The counts differ only by what was written in the last 10 minutes.
4. Delete the temporary table:

   ```sh
   aws dynamodb delete-table --region us-west-2 --table-name pictora-prod-restore-drill
   ```

In a real restore, the app can't switch tables by config: restore to a new table, then copy the needed items back into `pictora-prod`.

### Roll back prod

1. Note the live SHA: `curl -s https://pictora.rpillai.dev/api/health`.
2. Roll back to the previous release: `gh workflow run deploy.yml -f environment=production -f sha=<previous sha>`. Approve it, and check that `/api/health` shows that SHA.
3. Roll forward to the live SHA the same way, and check `/api/health` again.

## Private beta and launch

- **Admin access in prod:** while beta mode is on, only allowlisted emails can sign up. For the first admin, add your email to the allowlist from the CLI ([README: Private beta allowlist](../README.md#private-beta-allowlist)), sign up at https://pictora.rpillai.dev, then add yourself to the `admins` group ([README: Admin access](../README.md#admin-access)) and sign out and in again. After that, manage the allowlist at `/admin/beta`.
- **Invite testers:** add their emails at `/admin/beta`. Removing an email doesn't touch an account already created.
- **End of beta:** check the success metrics on `/admin` against the PRD targets. To launch, set `betaMode` to false for prod in `infra/cdk.json` and deploy. To extend, leave it on and record the decision on #33.

## Domain move (one time, #33)

This release moved dev to `dev.pictora.rpillai.dev` and gave prod `pictora.rpillai.dev`. The pipeline deploys dev first, which releases the old name, then prod claims it. After the first deploy:

- The old dev certificate for `pictora.rpillai.dev` in ACM (us-east-1) may be left behind as not in use, if CloudFormation couldn't delete it while the dev distribution still used it. Delete it from the ACM console once it shows "In use: No".
- The prod Cognito app client calls back to `https://pictora.rpillai.dev/auth/callback`. Sign in on prod once to confirm Google sign-in works on the new domain.
