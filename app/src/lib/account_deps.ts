import {
  AdminDisableUserCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { PurgeMessage } from '@pictora/core';
import type { AccountDeps } from './account';
import { documentClient, tableName } from './dynamodb';

let cognito: CognitoIdentityProviderClient | undefined;
let sqs: SQSClient | undefined;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** Sends `message` to the purge queue (`PURGE_QUEUE_URL`). */
export async function sendPurge(message: PurgeMessage): Promise<void> {
  sqs ??= new SQSClient({});
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: required('PURGE_QUEUE_URL'),
      MessageBody: JSON.stringify(message),
    }),
  );
}

/** The account API's dependencies in a deployed app: DynamoDB, the Cognito user pool and the purge queue. */
export function accountDeps(): AccountDeps {
  const userPoolId = required('COGNITO_USER_POOL_ID');
  cognito ??= new CognitoIdentityProviderClient({});
  const client = cognito;
  return {
    client: documentClient(),
    tableName: tableName(),
    disableUser: async (username) => {
      await client.send(
        new AdminDisableUserCommand({ UserPoolId: userPoolId, Username: username }),
      );
    },
    signOutUser: async (username) => {
      await client.send(
        new AdminUserGlobalSignOutCommand({ UserPoolId: userPoolId, Username: username }),
      );
    },
    requestPurge: sendPurge,
    now: () => new Date(),
  };
}
