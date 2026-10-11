import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadSeedRegistry, type ModelConfig } from '../src/registry.js';
import {
  createRegistryLoader,
  dynamoRegistrySource,
  modelFromItem,
  modelsAvailableIn,
  planRegistrySeed,
  registryItem,
  REGISTRY_CACHE_MS,
  seedRegistry,
} from '../src/registry_store.js';

const seed = loadSeedRegistry();
const model = (id: string): ModelConfig => {
  const found = seed.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no ${id} in the seed`);
  return found;
};

describe('registryItem and modelFromItem', () => {
  it('stores a model under MODEL#<id>/CONFIG with the registry GSI keys, and reads it back', () => {
    const item = registryItem(model('gpt-image-2'));
    expect(item).toMatchObject({
      PK: 'MODEL#gpt-image-2',
      SK: 'CONFIG',
      GSI1PK: 'REGISTRY',
      GSI1SK: 'gpt-image-2',
    });
    expect(modelFromItem(item)).toEqual(model('gpt-image-2'));
  });

  it('skips items that are not valid registry entries', () => {
    expect(modelFromItem({ PK: 'MODEL#x', SK: 'CONFIG', id: 'x' })).toBeUndefined();
  });
});

describe('planRegistrySeed', () => {
  const on = model('gpt-image-2');
  const off = model('gemini-3-pro-image');

  it('takes enabled from the seed for a new model', () => {
    const plan = planRegistrySeed([on, { ...off, enabled: false }], []);
    expect(plan.added).toEqual([on.id, off.id]);
    expect(plan.items.map((item) => item.enabled)).toEqual([true, false]);
  });

  it('keeps an existing model switched on, and updates the rest of its config from the seed', () => {
    const stored = registryItem({ ...on, displayName: 'Old name', enabled: true });
    const plan = planRegistrySeed([on], [stored]);
    expect(plan.kept).toEqual([on.id]);
    expect(plan.items).toEqual([registryItem(on)]);
  });

  it('keeps an existing model switched off even though the seed says enabled', () => {
    const plan = planRegistrySeed([on], [registryItem({ ...on, enabled: false })]);
    expect(plan.kept).toEqual([on.id]);
    expect(plan.items[0]).toMatchObject({ id: on.id, enabled: false });
  });

  it('switches off a model removed from the seed instead of deleting it', () => {
    const removed = registryItem({ ...off, enabled: true });
    const plan = planRegistrySeed([on], [registryItem(on), removed]);
    expect(plan.removed).toEqual([off.id]);
    expect(plan.items).toContainEqual({ ...removed, enabled: false });
    expect(plan.items).toHaveLength(2);
  });
});

describe('modelsAvailableIn', () => {
  it('lists mock in dev only', () => {
    expect(modelsAvailableIn(seed, 'dev').map((m) => m.id)).toContain('mock');
    expect(modelsAvailableIn(seed, 'prod').map((m) => m.id)).not.toContain('mock');
  });

  it('never lists a mock model in prod, even one wrongly marked for prod', () => {
    const wronglyMarked = { ...model('mock'), environments: ['dev', 'prod'] as const };
    expect(
      modelsAvailableIn([{ ...wronglyMarked, environments: ['dev', 'prod'] }], 'prod'),
    ).toEqual([]);
  });
});

describe('createRegistryLoader', () => {
  function loader(models: ModelConfig[], environment: 'dev' | 'prod' = 'dev') {
    let clock = 0;
    // A copy per read, as DynamoDB returns, so later changes to `models` show only after a refresh.
    const source = vi.fn(async () => models.map((m) => ({ ...m })));
    const instance = createRegistryLoader({ source, environment, now: () => clock });
    return { instance, source, advance: (ms: number) => (clock += ms) };
  }

  it('caches the registry for 60 s, then reads it again', async () => {
    const { instance, source, advance } = loader(seed);
    await instance.models();
    advance(REGISTRY_CACHE_MS - 1);
    await instance.models();
    expect(source).toHaveBeenCalledTimes(1);
    advance(1);
    await instance.models();
    expect(source).toHaveBeenCalledTimes(2);
  });

  it('shares one read between concurrent callers', async () => {
    const { instance, source } = loader(seed);
    await Promise.all([instance.models(), instance.enabledModels(), instance.models()]);
    expect(source).toHaveBeenCalledTimes(1);
  });

  it('drops a switched-off model from enabledModels once the cache expires', async () => {
    const models = seed.map((m) => ({ ...m }));
    const { instance, advance } = loader(models);
    expect((await instance.enabledModels()).map((m) => m.id)).toContain('gpt-image-2');

    models.find((m) => m.id === 'gpt-image-2')!.enabled = false;
    expect((await instance.enabledModels()).map((m) => m.id)).toContain('gpt-image-2');
    advance(REGISTRY_CACHE_MS);
    const ids = (await instance.enabledModels()).map((m) => m.id);
    expect(ids).not.toContain('gpt-image-2');
    expect((await instance.models()).map((m) => m.id)).toContain('gpt-image-2');
  });

  it('filters by environment', async () => {
    const dev = loader(seed, 'dev');
    const prod = loader(seed, 'prod');
    expect((await dev.instance.enabledModels()).map((m) => m.id)).toContain('mock');
    expect((await prod.instance.enabledModels()).map((m) => m.id)).not.toContain('mock');
  });

  it('keeps serving the last registry when a refresh fails, and fails when it has none', async () => {
    const source = vi.fn<() => Promise<ModelConfig[]>>().mockResolvedValueOnce(seed);
    let clock = 0;
    const instance = createRegistryLoader({ source, environment: 'dev', now: () => clock });
    await instance.models();
    source.mockRejectedValue(new Error('DynamoDB down'));
    clock += REGISTRY_CACHE_MS;
    expect(await instance.models()).toHaveLength(modelsAvailableIn(seed, 'dev').length);

    const empty = createRegistryLoader({
      source: async () => Promise.reject(new Error('DynamoDB down')),
      environment: 'dev',
    });
    await expect(empty.models()).rejects.toThrow('DynamoDB down');
  });
});

// Runs against DynamoDB Local when DYNAMODB_ENDPOINT is set, as in CI (tech design 13).
const endpoint = process.env.DYNAMODB_ENDPOINT;

describe.skipIf(!endpoint)('seedRegistry against DynamoDB Local', () => {
  const tableName = `pictora-registry-test-${Date.now()}`;
  const raw = new DynamoDBClient({
    endpoint,
    region: 'us-west-2',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  const client = DynamoDBDocumentClient.from(raw);
  const enabledOf = async (id: string) =>
    (
      await client.send(
        new GetCommand({ TableName: tableName, Key: { PK: `MODEL#${id}`, SK: 'CONFIG' } }),
      )
    ).Item?.enabled;

  beforeAll(async () => {
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
  });

  afterAll(async () => {
    await raw.send(new DeleteTableCommand({ TableName: tableName }));
  });

  it('seeds every model, keeps a kill switch across redeploys, and switches off removed models', async () => {
    const first = await seedRegistry(client, tableName, seed);
    expect(first.added).toEqual(seed.map((m) => m.id));
    const loaded = await dynamoRegistrySource(client, tableName)();
    expect(loaded.map((m) => m.id).sort()).toEqual(seed.map((m) => m.id).sort());

    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: 'MODEL#gpt-image-2', SK: 'CONFIG' },
        UpdateExpression: 'SET enabled = :off',
        ExpressionAttributeValues: { ':off': false },
      }),
    );
    const withoutPro = seed.filter((m) => m.id !== 'gemini-3-pro-image');
    const second = await seedRegistry(client, tableName, withoutPro);

    expect(second.kept).toContain('gpt-image-2');
    expect(second.removed).toEqual(['gemini-3-pro-image']);
    expect(await enabledOf('gpt-image-2')).toBe(false);
    expect(await enabledOf('gemini-3-pro-image')).toBe(false);
    expect(await enabledOf('gemini-3.1-flash-image')).toBe(true);
  });
});
