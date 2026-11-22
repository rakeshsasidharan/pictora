import {
  BedrockClient,
  GetFoundationModelAvailabilityCommand,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
} from '@aws-sdk/client-bedrock';
import { mockClient } from 'aws-sdk-client-mock';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  bedrockModelAccess,
  bedrockModelCallable,
  bedrockModelCatalogue,
  geminiModelCatalogue,
  openAiModelCatalogue,
} from '../src/model_catalogue.js';

/** One mock for the file: a second `mockClient` of the same class would replace this one's stubs. */
const bedrock = mockClient(BedrockClient);
afterEach(() => bedrock.reset());

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('openAiModelCatalogue', () => {
  it('lists every model ID, following pages', async () => {
    server.use(
      http.get('https://openai.test/v1/models', ({ request }) => {
        expect(request.headers.get('authorization')).toBe('Bearer sk-test');
        return HttpResponse.json({
          object: 'list',
          data: [
            { id: 'gpt-image-2', object: 'model', created: 1, owned_by: 'openai' },
            { id: 'gpt-image-1-mini', object: 'model', created: 1, owned_by: 'openai' },
          ],
        });
      }),
    );
    const catalogue = await openAiModelCatalogue({
      apiKey: 'sk-test',
      baseURL: 'https://openai.test/v1',
    });
    expect([...catalogue.keys()]).toEqual(['gpt-image-2', 'gpt-image-1-mini']);
    expect(catalogue.get('gpt-image-2')).toEqual({ legacy: false });
  });

  it('throws when the API fails', async () => {
    server.use(
      http.get('https://openai.test/v1/models', () =>
        HttpResponse.json({ error: { message: 'bad key' } }, { status: 401 }),
      ),
    );
    await expect(
      openAiModelCatalogue({ apiKey: 'sk-bad', baseURL: 'https://openai.test/v1' }),
    ).rejects.toThrow();
  });
});

describe('geminiModelCatalogue', () => {
  it('lists every model, without the models/ prefix, across pages', async () => {
    server.use(
      http.get('https://gemini.test/v1beta/models', ({ request }) => {
        const token = new URL(request.url).searchParams.get('pageToken');
        return HttpResponse.json(
          token === 'page-2'
            ? { models: [{ name: 'models/gemini-3-pro-image' }] }
            : {
                models: [
                  { name: 'models/gemini-3.1-flash-image' },
                  { name: 'models/gemini-3.1-flash-lite-image' },
                ],
                nextPageToken: 'page-2',
              },
        );
      }),
    );
    const catalogue = await geminiModelCatalogue({
      config: { backend: 'api' },
      credential: 'gemini-key',
      baseUrl: 'https://gemini.test',
    });
    expect([...catalogue.keys()].sort()).toEqual([
      'gemini-3-pro-image',
      'gemini-3.1-flash-image',
      'gemini-3.1-flash-lite-image',
    ]);
  });

  it('throws when the API fails', async () => {
    server.use(
      http.get('https://gemini.test/v1beta/models', () =>
        HttpResponse.json({ error: { code: 500, message: 'oops' } }, { status: 500 }),
      ),
    );
    await expect(
      geminiModelCatalogue({
        config: { backend: 'api' },
        credential: 'gemini-key',
        baseUrl: 'https://gemini.test',
      }),
    ).rejects.toThrow();
  });
});

describe('bedrockModelCatalogue', () => {
  it('lists the Stability models with their lifecycle', async () => {
    bedrock.on(ListFoundationModelsCommand, { byProvider: 'stability' }).resolves({
      modelSummaries: [
        {
          modelArn: 'arn:a',
          modelId: 'stability.stable-image-core-v1:1',
          modelLifecycle: { status: 'ACTIVE' },
        },
        {
          modelArn: 'arn:b',
          modelId: 'stability.sd3-5-large-v1:0',
          modelLifecycle: { status: 'LEGACY', endOfLifeTime: new Date('2026-12-01T00:00:00Z') },
        },
      ],
    });
    bedrock.on(ListInferenceProfilesCommand).resolves({ inferenceProfileSummaries: [] });
    const catalogue = await bedrockModelCatalogue(new BedrockClient({ region: 'us-west-2' }));
    expect(Object.fromEntries(catalogue)).toEqual({
      'stability.stable-image-core-v1:1': { legacy: false },
      'stability.sd3-5-large-v1:0': { legacy: true, endOfLife: '2026-12-01' },
    });
  });

  it('adds the active system-defined Stability inference profiles, across pages', async () => {
    const profile = (id: string, model: string, status: 'ACTIVE' | string = 'ACTIVE') => ({
      inferenceProfileId: id,
      inferenceProfileName: id,
      inferenceProfileArn: `arn:aws:bedrock:us-west-2:111111111111:inference-profile/${id}`,
      type: 'SYSTEM_DEFINED' as const,
      status: status as 'ACTIVE',
      models: [
        { modelArn: `arn:aws:bedrock:us-west-2::foundation-model/${model}` },
        { modelArn: `arn:aws:bedrock:us-east-1::foundation-model/${model}` },
      ],
    });
    bedrock.on(ListFoundationModelsCommand).resolves({ modelSummaries: [] });
    bedrock
      .on(ListInferenceProfilesCommand, { typeEquals: 'SYSTEM_DEFINED', nextToken: undefined })
      .resolves({
        inferenceProfileSummaries: [
          profile('us.stability.stable-fast-upscale-v1:0', 'stability.stable-fast-upscale-v1:0'),
          profile('us.anthropic.claude-model-v1:0', 'anthropic.claude-model-v1:0'),
        ],
        nextToken: 'page-2',
      })
      .on(ListInferenceProfilesCommand, { typeEquals: 'SYSTEM_DEFINED', nextToken: 'page-2' })
      .resolves({
        inferenceProfileSummaries: [
          profile('us.stability.stable-outpaint-v1:0', 'stability.stable-outpaint-v1:0'),
          profile(
            'us.stability.stable-image-old-v1:0',
            'stability.stable-image-old-v1:0',
            'INACTIVE',
          ),
        ],
      });
    const catalogue = await bedrockModelCatalogue(new BedrockClient({ region: 'us-west-2' }));
    expect(Object.fromEntries(catalogue)).toEqual({
      'us.stability.stable-fast-upscale-v1:0': { legacy: false },
      'us.stability.stable-outpaint-v1:0': { legacy: false },
    });
  });

  it('fails when the inference profiles cannot be listed, so no model is flagged', async () => {
    bedrock.on(ListFoundationModelsCommand).resolves({ modelSummaries: [] });
    bedrock.on(ListInferenceProfilesCommand).rejects(new Error('AccessDeniedException'));
    await expect(bedrockModelCatalogue(new BedrockClient({ region: 'us-west-2' }))).rejects.toThrow(
      'AccessDeniedException',
    );
  });
});

describe('bedrockModelAccess', () => {
  const client = () => new BedrockClient({ region: 'us-west-2' });

  it('reads the access to a model by its inference profile ID', async () => {
    bedrock
      .on(GetFoundationModelAvailabilityCommand, { modelId: 'us.amazon.nova-2-lite-v1:0' })
      .resolves({
        modelId: 'amazon.nova-2-lite-v1:0',
        agreementAvailability: { status: 'AVAILABLE' },
        authorizationStatus: 'AUTHORIZED',
        entitlementAvailability: 'AVAILABLE',
        regionAvailability: 'AVAILABLE',
      });
    const access = await bedrockModelAccess('us.amazon.nova-2-lite-v1:0', client());
    expect(access).toEqual({
      agreement: 'AVAILABLE',
      authorization: 'AUTHORIZED',
      entitlement: 'AVAILABLE',
      region: 'AVAILABLE',
    });
    expect(bedrockModelCallable(access!)).toBe(true);
  });

  it('reports a Marketplace model with no agreement as not callable (#194)', async () => {
    bedrock.on(GetFoundationModelAvailabilityCommand).resolves({
      modelId: 'openai.gpt-5.6-luna',
      agreementAvailability: { status: 'NOT_AVAILABLE' },
      authorizationStatus: 'AUTHORIZED',
      entitlementAvailability: 'AVAILABLE',
      regionAvailability: 'AVAILABLE',
    });
    const access = await bedrockModelAccess('us.openai.gpt-5.6-luna', client());
    expect(access?.agreement).toBe('NOT_AVAILABLE');
    expect(bedrockModelCallable(access!)).toBe(false);
  });

  it('treats a missing field as not available', async () => {
    bedrock.on(GetFoundationModelAvailabilityCommand).resolves({ modelId: 'amazon.x' });
    const access = await bedrockModelAccess('amazon.x', client());
    expect(access).toEqual({
      agreement: 'ERROR',
      authorization: 'NOT_AUTHORIZED',
      entitlement: 'NOT_AVAILABLE',
      region: 'NOT_AVAILABLE',
    });
    expect(bedrockModelCallable(access!)).toBe(false);
  });

  it.each(['ValidationException', 'ResourceNotFoundException'])(
    'returns undefined for an ID Bedrock does not know (%s)',
    async (name) => {
      bedrock
        .on(GetFoundationModelAvailabilityCommand)
        .rejects(Object.assign(new Error('The provided model identifier is invalid.'), { name }));
      await expect(bedrockModelAccess('amazon.nope-v1:0', client())).resolves.toBeUndefined();
    },
  );

  it('throws on any other failure, so an outage is not a missing model', async () => {
    bedrock
      .on(GetFoundationModelAvailabilityCommand)
      .rejects(Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }));
    await expect(bedrockModelAccess('amazon.nova-2-lite-v1:0', client())).rejects.toThrow(
      'Rate exceeded',
    );
  });

  it('needs every part of the access to be available', () => {
    const callable = {
      agreement: 'AVAILABLE',
      authorization: 'AUTHORIZED',
      entitlement: 'AVAILABLE',
      region: 'AVAILABLE',
    };
    expect(bedrockModelCallable(callable)).toBe(true);
    expect(bedrockModelCallable({ ...callable, agreement: 'PENDING' })).toBe(false);
    expect(bedrockModelCallable({ ...callable, authorization: 'NOT_AUTHORIZED' })).toBe(false);
    expect(bedrockModelCallable({ ...callable, entitlement: 'NOT_AVAILABLE' })).toBe(false);
    expect(bedrockModelCallable({ ...callable, region: 'NOT_AVAILABLE' })).toBe(false);
  });
});
