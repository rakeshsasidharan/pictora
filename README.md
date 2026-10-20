# pictora

Pictora is a free web app that turns text prompts into high-quality PNG images, from artistic to photorealistic. Users can refine images in plain words and keep them in a private gallery. It runs OpenAI and Google Gemini image models behind one provider-neutral backend, with Amazon Bedrock (Stability AI) planned as a lower-cost tier. Built with Next.js and hosted on AWS.

See the [product requirements](docs/prd.md) for details.

## Operations

### Clearing an abuse flag

New accounts with a disposable email domain, or past the third sign-up from one IP in a day, get `abuseFlag` (`disposable_email` or `many_accounts`) on their profile and 5 points a day. To clear a flag by hand, find the user's `sub` (Cognito console, or the profile's `email`), then remove the attribute:

```sh
aws dynamodb update-item --region us-west-2 --table-name pictora-<env> \
  --key '{"PK":{"S":"USER#<sub>"},"SK":{"S":"PROFILE"}}' \
  --update-expression 'REMOVE abuseFlag'
```

The default allowance applies from the user's next request. To give one user a different allowance instead, set `dailyPoints` on the same item (ADM-5), which wins over the flag. A user who signed up but hasn't used the app yet has no profile; their flag waits in `PK = SIGNUP#<email in lower case>`, `SK = ABUSE` for 30 days, and deleting that item clears it.

### Platform spend cap

Provider spend for the month is counted in `PK = PLATFORM`, `SK = SPEND#<yyyy-mm>` (`spentCents`). Once it reaches the cap (`spendCapUsd` in `infra/cdk.json`: $20 in dev, $100 in prod), only Draft quality can be used until the start of next month (UTC), and the spend alarms email at 80% and 100%. Raising the cap is a config change and a deploy.
