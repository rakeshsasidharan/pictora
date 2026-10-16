import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/** DynamoDB Local's endpoint, as CI sets it (tech design 13). Tests that need it skip without it. */
export const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT;

/** A fresh table shaped like `pictora-<env>` (tech design 4) in DynamoDB Local, and a client for it. */
export function localTable(prefix: string) {
  const tableName = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const raw = new DynamoDBClient({
    endpoint: DYNAMODB_ENDPOINT,
    region: 'us-west-2',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  const client = DynamoDBDocumentClient.from(raw, {
    marshallOptions: { removeUndefinedValues: true },
  });
  return {
    tableName,
    client,
    async create() {
      await raw.send(
        new CreateTableCommand({
          TableName: tableName,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: ['PK', 'SK', 'GSI1PK', 'GSI1SK'].map((AttributeName) => ({
            AttributeName,
            AttributeType: 'S',
          })),
          KeySchema: [
            { AttributeName: 'PK', KeyType: 'HASH' },
            { AttributeName: 'SK', KeyType: 'RANGE' },
          ],
          GlobalSecondaryIndexes: [
            {
              IndexName: 'GSI1',
              KeySchema: [
                { AttributeName: 'GSI1PK', KeyType: 'HASH' },
                { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
              ],
              Projection: { ProjectionType: 'ALL' },
            },
          ],
        }),
      );
    },
    async drop() {
      await raw.send(new DeleteTableCommand({ TableName: tableName }));
    },
  };
}
