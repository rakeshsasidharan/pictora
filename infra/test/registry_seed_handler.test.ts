import { readFileSync } from 'node:fs';
import { BatchWriteCommand, DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handler,
  seedRegistryHandler,
  type RegistrySeedEvent,
} from '../lambda/registry_seed_handler.js';
import { MODELS_JSON_PATH } from '../lib/data_stack.js';

const seedJson = readFileSync(MODELS_JSON_PATH, 'utf8');
const seedIds: string[] = JSON.parse(seedJson).map((model: { id: string }) => model.id);

/** A document client whose registry query returns `stored`, recording every write. */
function fakeClient(stored: Record<string, unknown>[] = []) {
  const writes: Record<string, unknown>[] = [];
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof QueryCommand) return { Items: stored };
    if (command instanceof BatchWriteCommand) {
      const requests = command.input.RequestItems?.['pictora-dev'] ?? [];
      writes.push(...requests.map((request) => request.PutRequest?.Item ?? {}));
      return {};
    }
    throw new Error('unexpected command');
  });
  return { client: { send } as unknown as DynamoDBDocumentClient, send, writes };
}

function event(requestType: RegistrySeedEvent['RequestType'], seed = seedJson): RegistrySeedEvent {
  return {
    RequestType: requestType,
    ResourceProperties: { TableName: 'pictora-dev', Seed: seed },
  };
}

describe('registry seed handler', () => {
  it('writes every seed model on create and reports what it added', async () => {
    const { client, writes } = fakeClient();
    const response = await seedRegistryHandler(event('Create'), client);
    expect(writes.map((item) => item.GSI1SK)).toEqual(seedIds);
    expect(response).toEqual({
      PhysicalResourceId: 'registry-seed-pictora-dev',
      Data: { added: seedIds.join(','), kept: '', removed: '' },
    });
  });

  it('keeps a kill switch on update', async () => {
    const stored = [
      { PK: 'MODEL#gpt-image-2', SK: 'CONFIG', GSI1SK: 'gpt-image-2', enabled: false },
    ];
    const { client, writes } = fakeClient(stored);
    const response = await seedRegistryHandler(event('Update'), client);
    expect(writes.find((item) => item.id === 'gpt-image-2')).toMatchObject({ enabled: false });
    expect(response.Data?.kept).toBe('gpt-image-2');
  });

  it('writes nothing on delete, so the registry stays', async () => {
    const { client, send } = fakeClient();
    const response = await seedRegistryHandler(
      { ...event('Delete'), PhysicalResourceId: 'existing-id' },
      client,
    );
    expect(response).toEqual({ PhysicalResourceId: 'existing-id' });
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses an invalid seed before writing anything', async () => {
    const { client, send } = fakeClient();
    await expect(seedRegistryHandler(event('Update', '[{"id":"broken"}]'), client)).rejects.toThrow(
      /Invalid model registry/,
    );
    expect(send).not.toHaveBeenCalled();
  });
});

describe('registry seed Lambda entry point', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses its own document client, not the Lambda context Lambda passes second', async () => {
    const writes: Record<string, unknown>[] = [];
    const send = vi
      .spyOn(DynamoDBDocumentClient.prototype, 'send')
      .mockImplementation(async (command: unknown) => {
        if (command instanceof QueryCommand) return { Items: [] };
        if (command instanceof BatchWriteCommand) {
          const requests = command.input.RequestItems?.['pictora-dev'] ?? [];
          writes.push(...requests.map((request) => request.PutRequest?.Item ?? {}));
          return {};
        }
        throw new Error('unexpected command');
      });
    const lambdaContext = {
      functionName: 'PictoraDev-Data-RegistrySeedHandler',
      awsRequestId: 'request-id',
      getRemainingTimeInMillis: () => 120_000,
    };
    const lambdaHandler = handler as (
      event: RegistrySeedEvent,
      context: unknown,
    ) => ReturnType<typeof handler>;

    const response = await lambdaHandler(event('Create'), lambdaContext);

    expect(send).toHaveBeenCalled();
    expect(writes.map((item) => item.GSI1SK)).toEqual(seedIds);
    expect(response.PhysicalResourceId).toBe('registry-seed-pictora-dev');
  });
});
