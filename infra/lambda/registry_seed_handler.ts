import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
// Imported from source and bundled by esbuild, so synth and tests don't need packages/core built first.
import { parseRegistry } from '../../packages/core/src/registry.js';
import { seedRegistry } from '../../packages/core/src/registry_store.js';

/** The custom resource properties the `Data` stack sends. CloudFormation passes every value as a string. */
export interface RegistrySeedProperties {
  TableName: string;
  /** `packages/core/models.json`, as a JSON string. */
  Seed: string;
}

/** The subset of the CDK Provider framework's onEvent request this handler reads. */
export interface RegistrySeedEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
  ResourceProperties: RegistrySeedProperties & Record<string, unknown>;
}

export interface RegistrySeedResponse {
  PhysicalResourceId: string;
  Data?: { added: string; kept: string; removed: string };
}

let client: DynamoDBDocumentClient | undefined;

/**
 * The Lambda entry point. Lambda calls it as `handler(event, context)`, so the document client can't be an
 * optional second parameter: the context would take its place.
 */
export async function handler(event: RegistrySeedEvent): Promise<RegistrySeedResponse> {
  client ??= DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return seedRegistryHandler(event, client);
}

/**
 * Seeds the model registry on every deploy (tech design 6.1): upserts every `models.json` entry into
 * `MODEL#<id>/CONFIG`, keeping the `enabled` value already in DynamoDB, and switches off models removed from the
 * seed. Deleting the resource leaves the registry in place.
 */
export async function seedRegistryHandler(
  event: RegistrySeedEvent,
  documentClient: DynamoDBDocumentClient,
): Promise<RegistrySeedResponse> {
  const { TableName, Seed } = event.ResourceProperties;
  const physicalResourceId = event.PhysicalResourceId ?? `registry-seed-${TableName}`;
  if (event.RequestType === 'Delete') return { PhysicalResourceId: physicalResourceId };

  const seed = parseRegistry(JSON.parse(Seed));
  const plan = await seedRegistry(documentClient, TableName, seed);
  console.log(JSON.stringify({ message: 'Model registry seeded', ...plan, items: undefined }));
  return {
    PhysicalResourceId: physicalResourceId,
    Data: {
      added: plan.added.join(','),
      kept: plan.kept.join(','),
      removed: plan.removed.join(','),
    },
  };
}
