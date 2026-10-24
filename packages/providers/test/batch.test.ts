import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createBatchProviderFactory, isBatchProvider } from '../src/batch.js';
import { BedrockProvider } from '../src/bedrock.js';
import { ProviderError, ProviderSafetyError, ProviderTimeoutError } from '../src/errors.js';
import { GeminiProvider } from '../src/gemini.js';
import { MOCK_BATCH_PREFIX, MockProvider } from '../src/mock.js';
import { OPENAI_BATCH_ENDPOINT, OpenAiProvider } from '../src/openai.js';
import type { BatchItem } from '../src/types.js';
import { seedModel, solidImage } from './helpers.js';

const OPENAI_URL = 'https://openai.test/v1';
const GEMINI_URL = 'https://gemini.test';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const signal = () => new AbortController().signal;

function item(key: string, overrides: Partial<BatchItem['request']> = {}): BatchItem {
  return {
    key,
    request: {
      prompt: `A lighthouse ${key}`,
      aspect: '1:1',
      quality: 'draft',
      count: 1,
      ...overrides,
    },
  };
}

function fixture(provider: 'openai' | 'gemini', name: string, image?: Uint8Array): unknown {
  const text = readFileSync(
    new URL(`./fixtures/${provider}/${name}.json`, import.meta.url),
    'utf8',
  );
  return JSON.parse(
    image ? text.replaceAll('__IMAGE__', Buffer.from(image).toString('base64')) : text,
  ) as unknown;
}

const jsonl = (lines: unknown[]) => `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;

describe('OpenAI batches', () => {
  const gptImage2 = seedModel('gpt-image-2');
  const openai = () => new OpenAiProvider({ apiKey: async () => 'sk-test', baseURL: OPENAI_URL });

  it('uploads one images request per job as JSONL and creates a 24-hour batch', async () => {
    const seen: { file?: string; purpose?: string; batch?: Record<string, unknown> } = {};
    server.use(
      http.post(`${OPENAI_URL}/files`, async ({ request }) => {
        const form = await request.formData();
        seen.purpose = String(form.get('purpose'));
        seen.file = await (form.get('file') as File).text();
        return HttpResponse.json({ id: 'file-in', object: 'file', purpose: 'batch' });
      }),
      http.post(`${OPENAI_URL}/batches`, async ({ request }) => {
        seen.batch = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: 'batch_1', status: 'validating' });
      }),
    );
    const batchId = await openai().submitBatch(
      gptImage2,
      [item('JOB1'), item('JOB2', { count: 3, quality: 'high', aspect: '3:2' })],
      signal(),
    );

    expect(batchId).toBe('batch_1');
    expect(seen.purpose).toBe('batch');
    const lines = seen
      .file!.trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown);
    expect(lines).toEqual([
      {
        custom_id: 'JOB1',
        method: 'POST',
        url: OPENAI_BATCH_ENDPOINT,
        body: expect.objectContaining({
          model: 'gpt-image-2',
          prompt: 'A lighthouse JOB1',
          n: 1,
          output_format: 'png',
        }),
      },
      {
        custom_id: 'JOB2',
        method: 'POST',
        url: OPENAI_BATCH_ENDPOINT,
        body: expect.objectContaining({ n: 3, quality: 'high', size: '1536x1024' }),
      },
    ]);
    expect(seen.batch).toMatchObject({
      input_file_id: 'file-in',
      endpoint: '/v1/images/generations',
      completion_window: '24h',
    });
  });

  it('refuses a model without batch jobs, or an empty batch', async () => {
    const noBatch = { ...gptImage2, capabilities: { ...gptImage2.capabilities, batch: false } };
    await expect(openai().submitBatch(noBatch, [item('JOB1')], signal())).rejects.toThrow(
      ProviderError,
    );
    await expect(openai().submitBatch(gptImage2, [], signal())).rejects.toThrow(ProviderError);
  });

  it('is pending while the batch validates, runs or finalises', async () => {
    for (const status of ['validating', 'in_progress', 'finalizing', 'cancelling']) {
      server.use(
        http.get(`${OPENAI_URL}/batches/batch_1`, () =>
          HttpResponse.json({ id: 'batch_1', status }),
        ),
      );
      expect(await openai().pollBatch(gptImage2, 'batch_1', [item('JOB1')], signal())).toEqual({
        state: 'pending',
      });
    }
  });

  it('reads a completed batch: images at half price, failed lines with their errors', async () => {
    const png = await solidImage('png', 1024, 1024);
    server.use(
      http.get(`${OPENAI_URL}/batches/batch_1`, () =>
        HttpResponse.json({
          id: 'batch_1',
          status: 'completed',
          output_file_id: 'file-out',
          error_file_id: 'file-err',
        }),
      ),
      http.get(`${OPENAI_URL}/files/file-out/content`, () =>
        HttpResponse.text(
          jsonl([
            {
              custom_id: 'JOB1',
              response: { status_code: 200, body: fixture('openai', 'generate_gpt_image_2', png) },
            },
            {
              custom_id: 'JOB2',
              response: {
                status_code: 400,
                body: {
                  error: {
                    message: 'Your request was rejected by the safety system.',
                    code: 'moderation_blocked',
                  },
                },
              },
            },
            // Not one of this batch's jobs.
            { custom_id: 'OTHER', response: { status_code: 200, body: { data: [] } } },
          ]),
        ),
      ),
      http.get(`${OPENAI_URL}/files/file-err/content`, () =>
        HttpResponse.text(
          jsonl([{ custom_id: 'JOB3', error: { message: 'Server error', code: 'server_error' } }]),
        ),
      ),
    );
    const poll = await openai().pollBatch(
      gptImage2,
      'batch_1',
      [item('JOB1'), item('JOB2'), item('JOB3'), item('JOB4')],
      signal(),
    );

    expect(poll.state).toBe('done');
    if (poll.state !== 'done') return;
    expect(poll.expired).toBe(false);
    expect([...poll.results.keys()]).toEqual(['JOB1', 'JOB2', 'JOB3']);
    const first = poll.results.get('JOB1')!;
    expect(first.images).toHaveLength(1);
    expect(first.images[0]).toMatchObject({ width: 1024, height: 1024 });
    // 18 text tokens at $5 and 1,056 image tokens at $30 per million is 3.177 cents; half is 1.59.
    expect(first.providerCostCents).toBe(1.59);
    expect(first.error).toBeUndefined();
    expect(poll.results.get('JOB2')!.error).toBeInstanceOf(ProviderSafetyError);
    const third = poll.results.get('JOB3')!;
    expect(third.images).toEqual([]);
    expect(third.error).toBeInstanceOf(ProviderError);
    expect(third.error).not.toBeInstanceOf(ProviderSafetyError);
  });

  it('marks an expired or cancelled batch, with the results it has', async () => {
    for (const status of ['expired', 'cancelled']) {
      server.use(
        http.get(`${OPENAI_URL}/batches/batch_1`, () =>
          HttpResponse.json({ id: 'batch_1', status }),
        ),
      );
      const poll = await openai().pollBatch(gptImage2, 'batch_1', [item('JOB1')], signal());
      expect(poll).toEqual({ state: 'done', expired: true, results: new Map() });
    }
  });

  it('reports a failed batch', async () => {
    server.use(
      http.get(`${OPENAI_URL}/batches/batch_1`, () =>
        HttpResponse.json({
          id: 'batch_1',
          status: 'failed',
          errors: { data: [{ message: 'Invalid JSONL' }] },
        }),
      ),
    );
    const poll = await openai().pollBatch(gptImage2, 'batch_1', [item('JOB1')], signal());
    expect(poll.state).toBe('failed');
    expect(poll.state === 'failed' && poll.error.message).toContain('Invalid JSONL');
  });
});

describe('Gemini batches', () => {
  const flash = seedModel('gemini-3.1-flash-image');
  const gemini = (backend: 'api' | 'vertex' = 'api') =>
    new GeminiProvider({
      config: backend === 'api' ? { backend } : { backend, project: 'p', location: 'global' },
      credential: async () =>
        backend === 'api'
          ? 'g-key'
          : JSON.stringify({ project_id: 'p', client_email: 'a@b.c', private_key: 'x' }),
      baseUrl: GEMINI_URL,
    });

  it('sends one inline request per image, keyed by job and image', async () => {
    let body: { batch: { inputConfig: { requests: { requests: unknown[] } } } } | undefined;
    let url = '';
    server.use(
      http.post(
        /^https:\/\/gemini\.test\/v1beta\/models\/[^/]+:batchGenerateContent$/,
        async ({ request }) => {
          url = request.url;
          body = (await request.json()) as typeof body;
          return HttpResponse.json({
            name: 'batches/b1',
            metadata: { name: 'batches/b1', state: 'BATCH_STATE_PENDING' },
          });
        },
      ),
    );
    const name = await gemini().submitBatch(
      flash,
      [item('JOB1', { quality: 'standard' }), item('JOB2', { quality: 'high', count: 2 })],
      signal(),
    );

    expect(name).toBe('batches/b1');
    expect(url).toContain('/models/gemini-3.1-flash-image:batchGenerateContent');
    const requests = body!.batch.inputConfig.requests.requests as {
      request: { contents: { parts: { text?: string }[] }[]; generationConfig: unknown };
      metadata: { key: string };
    }[];
    expect(requests.map((request) => request.metadata.key)).toEqual(['JOB1#0', 'JOB2#0', 'JOB2#1']);
    expect(requests[0]!.request.contents[0]!.parts.at(-1)?.text).toBe('A lighthouse JOB1');
    expect(requests[0]!.request.generationConfig).toMatchObject({ responseModalities: ['IMAGE'] });
  });

  it('refuses batch jobs on Vertex AI', async () => {
    await expect(gemini('vertex').submitBatch(flash, [item('JOB1')], signal())).rejects.toThrow(
      /Gemini API backend/,
    );
  });

  it('is pending while the batch is queued or running', async () => {
    for (const state of ['BATCH_STATE_PENDING', 'BATCH_STATE_RUNNING']) {
      server.use(
        http.get(`${GEMINI_URL}/v1beta/batches/b1`, () =>
          HttpResponse.json({ name: 'batches/b1', metadata: { state } }),
        ),
      );
      expect(await gemini().pollBatch(flash, 'batches/b1', [item('JOB1')], signal())).toEqual({
        state: 'pending',
      });
    }
  });

  it('groups inline responses by job: images at half price, the safety refusal first', async () => {
    const png = await solidImage('png', 1024, 1024);
    const image = fixture('gemini', 'generate_image', png);
    server.use(
      http.get(`${GEMINI_URL}/v1beta/batches/b1`, () =>
        HttpResponse.json({
          name: 'batches/b1',
          metadata: {
            state: 'BATCH_STATE_SUCCEEDED',
            output: {
              inlinedResponses: {
                inlinedResponses: [
                  { response: image, metadata: { key: 'JOB1#0' } },
                  { response: image, metadata: { key: 'JOB1#1' } },
                  { response: fixture('gemini', 'image_safety'), metadata: { key: 'JOB2#0' } },
                  { error: { code: 500, message: 'Internal' }, metadata: { key: 'JOB2#1' } },
                  { error: { code: 500, message: 'Internal' }, metadata: { key: 'JOB3#0' } },
                ],
              },
            },
          },
        }),
      ),
    );
    const poll = await gemini().pollBatch(
      flash,
      'batches/b1',
      [
        item('JOB1', { quality: 'standard', count: 2 }),
        item('JOB2', { quality: 'standard', count: 2 }),
        item('JOB3', { quality: 'standard' }),
      ],
      signal(),
    );

    expect(poll.state).toBe('done');
    if (poll.state !== 'done') return;
    expect(poll.expired).toBe(false);
    const first = poll.results.get('JOB1')!;
    expect(first.images).toHaveLength(2);
    // Standard is 7 points an image; two at half price.
    expect(first.providerCostCents).toBe(7);
    expect(poll.results.get('JOB2')).toMatchObject({ images: [], providerCostCents: 0 });
    expect(poll.results.get('JOB2')!.error).toBeInstanceOf(ProviderSafetyError);
    expect(poll.results.get('JOB3')!.error).toBeInstanceOf(ProviderError);
    expect(poll.results.get('JOB3')!.error).not.toBeInstanceOf(ProviderSafetyError);
  });

  it('downloads results that come as a file, matching them by key', async () => {
    const png = await solidImage('png', 1024, 1024);
    let apiKey: string | null = null;
    server.use(
      http.get(`${GEMINI_URL}/v1beta/batches/b1`, () =>
        HttpResponse.json({
          name: 'batches/b1',
          metadata: { state: 'BATCH_STATE_EXPIRED', output: { responsesFile: 'files/out-1' } },
        }),
      ),
      http.get(`${GEMINI_URL}/download/v1beta/files/out-1:download`, ({ request }) => {
        apiKey = request.headers.get('x-goog-api-key');
        return HttpResponse.text(
          jsonl([{ key: 'JOB2#0', response: fixture('gemini', 'generate_image', png) }]),
        );
      }),
    );
    const poll = await gemini().pollBatch(
      flash,
      'batches/b1',
      [item('JOB1', { quality: 'standard' }), item('JOB2', { quality: 'standard' })],
      signal(),
    );

    expect(apiKey).toBe('g-key');
    expect(poll.state === 'done' && poll.expired).toBe(true);
    if (poll.state !== 'done') return;
    expect([...poll.results.keys()]).toEqual(['JOB2']);
    expect(poll.results.get('JOB2')!.images).toHaveLength(1);
  });

  it('reports a failed batch', async () => {
    server.use(
      http.get(`${GEMINI_URL}/v1beta/batches/b1`, () =>
        HttpResponse.json({ name: 'batches/b1', metadata: { state: 'BATCH_STATE_FAILED' } }),
      ),
    );
    const poll = await gemini().pollBatch(flash, 'batches/b1', [item('JOB1')], signal());
    expect(poll.state).toBe('failed');
  });
});

describe('mock batches', () => {
  const mock = seedModel('mock');

  it('accepts a batch and finishes it on the first read, at half price', async () => {
    const provider = new MockProvider({ delayMs: 0 });
    const items = [
      item('JOB1', { count: 2, quality: 'standard' }),
      item('JOB2', { prompt: 'A __block__ fox' }),
      item('JOB3', { prompt: 'A __fail__ fox' }),
      item('JOB4', { prompt: 'A __timeout__ fox' }),
    ];
    const batchId = await provider.submitBatch(mock, items);
    expect(batchId.startsWith(MOCK_BATCH_PREFIX)).toBe(true);
    expect(await provider.submitBatch(mock, items)).toBe(batchId);

    const poll = await provider.pollBatch(mock, batchId, items, signal());
    expect(poll.state === 'done' && poll.expired).toBe(false);
    if (poll.state !== 'done') return;
    expect(poll.results.get('JOB1')).toMatchObject({ providerCostCents: 2 });
    expect(poll.results.get('JOB1')!.images).toHaveLength(2);
    expect(poll.results.get('JOB2')!.error).toBeInstanceOf(ProviderSafetyError);
    expect(poll.results.get('JOB3')!.error).toBeInstanceOf(ProviderError);
    expect(poll.results.get('JOB4')!.error).toBeInstanceOf(ProviderTimeoutError);
  });

  it('fails a batch it never handed out', async () => {
    const poll = await new MockProvider().pollBatch(mock, 'batch_x', [item('JOB1')], signal());
    expect(poll.state).toBe('failed');
  });
});

describe('createBatchProviderFactory', () => {
  it('builds each batch adapter once and refuses providers without batches', () => {
    let built = 0;
    const factory = createBatchProviderFactory({
      mock: () => {
        built += 1;
        return new MockProvider();
      },
      bedrock: () => new BedrockProvider(),
    });
    const mock = seedModel('mock');
    expect(factory(mock)).toBe(factory(mock));
    expect(built).toBe(1);
    expect(() => factory(seedModel('stable-image-core'))).toThrow(/No batch adapter/);
    expect(() => factory(seedModel('gpt-image-2'))).toThrow(/No batch adapter/);
    expect(isBatchProvider(new BedrockProvider())).toBe(false);
    expect(isBatchProvider(new MockProvider())).toBe(true);
  });

  it('retries a read once on a transient error, and maps errors to typed ones', async () => {
    let reads = 0;
    const flaky = new MockProvider({ delayMs: 0 });
    const original = flaky.pollBatch.bind(flaky);
    flaky.pollBatch = async (...args) => {
      reads += 1;
      if (reads === 1) throw Object.assign(new Error('HTTP 503'), { status: 503 });
      return original(...args);
    };
    flaky.submitBatch = async () => {
      throw Object.assign(new Error('HTTP 503'), { status: 503 });
    };
    const factory = createBatchProviderFactory({ mock: () => flaky }, { delayMs: 0, jitterMs: 0 });
    const mock = seedModel('mock');
    const poll = await factory(mock).pollBatch(
      mock,
      `${MOCK_BATCH_PREFIX}x`,
      [item('JOB1')],
      signal(),
    );
    expect(poll.state).toBe('done');
    expect(reads).toBe(2);
    await expect(factory(mock).submitBatch(mock, [item('JOB1')], signal())).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});
