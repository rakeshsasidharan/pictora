import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

let client: DynamoDBDocumentClient | undefined;

/** The shared DynamoDB document client. `DYNAMODB_ENDPOINT` points it at DynamoDB Local for tests. */
export function documentClient(): DynamoDBDocumentClient {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  client ??= DynamoDBDocumentClient.from(new DynamoDBClient(endpoint ? { endpoint } : {}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return client;
}

/** The single table, `pictora-<env>` (tech design 4). */
export function tableName(): string {
  const name = process.env.TABLE_NAME;
  if (!name) throw new Error('TABLE_NAME is not set');
  return name;
}
