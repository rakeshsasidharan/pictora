import { BedrockClient, ListFoundationModelsCommand } from '@aws-sdk/client-bedrock';
import { mockClient } from 'aws-sdk-client-mock';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  bedrockModelCatalogue,
  geminiModelCatalogue,
  openAiModelCatalogue,
} from '../src/model_catalogue.js';

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
  const bedrock = mockClient(BedrockClient);
  afterEach(() => bedrock.reset());

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
    const catalogue = await bedrockModelCatalogue(new BedrockClient({ region: 'us-west-2' }));
    expect(Object.fromEntries(catalogue)).toEqual({
      'stability.stable-image-core-v1:1': { legacy: false },
      'stability.sd3-5-large-v1:0': { legacy: true, endOfLife: '2026-12-01' },
    });
  });
});
