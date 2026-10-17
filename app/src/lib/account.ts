import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  PROFILE_SK,
  TOS_VERSION,
  onboardingRequestSchema,
  userPk,
  type PurgeMessage,
} from '@pictora/core';
import { apiError, type ApiResult } from './jobs';
import { ensureProfile } from './profile';
import type { Session } from './session';

/** What the account API needs, so tests can swap Cognito, the purge queue and the clock. */
export interface AccountDeps {
  client: DynamoDBDocumentClient;
  tableName: string;
  /** Stops the user signing in again (Cognito `AdminDisableUser`). */
  disableUser: (username: string) => Promise<void>;
  /** Revokes the user's refresh tokens everywhere (Cognito `AdminUserGlobalSignOut`). */
  signOutUser: (username: string) => Promise<void>;
  /** Sends the purge message that deletes the account's data and the Cognito user. */
  requestPurge: (message: PurgeMessage) => Promise<void>;
  now: () => Date;
  /** The terms version users must accept; `TOS_VERSION` outside tests. */
  tosVersion?: string;
}

/**
 * `POST /api/me/onboarding` (AUTH-4): records that the user confirmed they are 13 or older and accepted the
 * terms and content policy, with the `TOS_VERSION` they accepted. A request for an older version (a page
 * open from before the terms changed) is refused, so nobody accepts text they weren't shown.
 */
export async function completeOnboarding(
  deps: AccountDeps,
  session: Session,
  input: unknown,
): Promise<ApiResult> {
  const parsed = onboardingRequestSchema.safeParse(input);
  if (!parsed.success) {
    return apiError(
      'invalid_request',
      'Confirm that you are 13 or older and accept the terms to continue.',
    );
  }
  const tosVersion = deps.tosVersion ?? TOS_VERSION;
  if (parsed.data.tosVersion !== tosVersion) {
    return apiError(
      'terms_changed',
      'The terms have changed since this page was opened. Reload it to see the new terms.',
    );
  }

  const now = deps.now();
  const profile = await ensureProfile(deps.client, deps.tableName, session, now);
  if (profile.status === 'deleting') {
    return apiError('account_deleting', 'Your account is being deleted.');
  }
  const tosAcceptedAt = now.toISOString();
  try {
    await deps.client.send(
      new UpdateCommand({
        TableName: deps.tableName,
        Key: { PK: userPk(session.sub), SK: PROFILE_SK },
        UpdateExpression:
          'SET tosAcceptedAt = :at, tosVersion = :version, ageConfirmed = :confirmed',
        ConditionExpression: 'attribute_exists(PK) AND #status <> :deleting',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':at': tosAcceptedAt,
          ':version': tosVersion,
          ':confirmed': true,
          ':deleting': 'deleting',
        },
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return apiError('account_deleting', 'Your account is being deleted.');
    }
    throw error;
  }
  return { status: 200, body: { tosAcceptedAt, tosVersion, ageConfirmed: true } };
}

/**
 * `DELETE /api/me` (AUTH-3). Right away: marks the profile `deleting` (so no new jobs start), queues the purge,
 * then disables the Cognito user and signs them out everywhere. The purge Lambda deletes the data and the
 * Cognito user within minutes. If the purge can't be queued, the profile goes back to how it was and the
 * user can try again; if Cognito can't be reached, the purge still deletes the user.
 */
export async function deleteAccount(deps: AccountDeps, session: Session): Promise<ApiResult> {
  const now = deps.now();
  const profile = await ensureProfile(deps.client, deps.tableName, session, now);
  const username = session.username ?? session.sub;
  const key = { PK: userPk(session.sub), SK: PROFILE_SK };

  await deps.client.send(
    new UpdateCommand({
      TableName: deps.tableName,
      Key: key,
      UpdateExpression: 'SET #status = :deleting, deletionRequestedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':deleting': 'deleting', ':now': now.toISOString() },
    }),
  );

  try {
    await deps.requestPurge({ sub: session.sub, username });
  } catch (error) {
    logError('Purge request failed; account left as it was', { error });
    if (profile.status !== 'deleting') {
      await deps.client.send(
        new UpdateCommand({
          TableName: deps.tableName,
          Key: key,
          UpdateExpression: 'SET #status = :previous REMOVE deletionRequestedAt',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':previous': profile.status },
        }),
      );
    }
    return apiError(
      'deletion_failed',
      "We couldn't start deleting your account. Nothing was deleted. Please try again.",
    );
  }

  for (const [step, run] of [
    ['disable', deps.disableUser],
    ['sign out', deps.signOutUser],
  ] as const) {
    try {
      await run(username);
    } catch (error) {
      // The purge deletes the Cognito user anyway, within minutes.
      logError(`Cognito ${step} failed during account deletion`, { error });
    }
  }
  return { status: 202, body: { status: 'deleting' } };
}

function logError(message: string, fields: Record<string, unknown>): void {
  const { error, ...rest } = fields;
  console.error(
    JSON.stringify({
      level: 'ERROR',
      message,
      ...rest,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}
