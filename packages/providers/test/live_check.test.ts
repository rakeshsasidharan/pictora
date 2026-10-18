import { loadSeedRegistry, type ModelConfig } from '@pictora/core';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CHECK_PROMPT,
  GEMINI_API_URL,
  GeminiCheckProvider,
  LIVE_PROVIDERS,
  OPENAI_API_URL,
  OPENAI_MODERATION_MODEL,
  OpenAiCheckProvider,
  cheapestQuality,
  formatResults,
  parseArgs,
  runChecks,
  secretName,
  selectModels,
  type CheckResult,
  type FetchFn,
} from '../scripts/live_check.js';
import { ProviderError, ProviderSafetyError } from '../src/errors.js';
import type { ImageProvider, ImageResult } from '../src/types.js';
import { request, seedModel, solidImage } from './helpers.js';

const gptImage2 = seedModel('gpt-image-2');
const gptMini = seedModel('gpt-image-1-mini');
const geminiFlash = seedModel('gemini-3.1-flash-image');
const geminiLite = seedModel('gemini-3.1-flash-lite-image');

let png: Uint8Array;
let pngBase64: string;
beforeAll(async () => {
  png = await solidImage('png', 32, 32);
  pngBase64 = Buffer.from(png).toString('base64');
});

/** A fake `fetch` that answers every call with one JSON response, and records the calls. */
function fakeFetch(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return vi.fn<FetchFn>(
    async () =>
      new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { 'content-type': 'application/json', ...init.headers },
      }),
  );
}

function sent(fetchFn: ReturnType<typeof fakeFetch>, index = 0) {
  const call = fetchFn.mock.calls[index];
  if (!call) throw new Error(`No fetch call ${index}`);
  const [url, init] = call;
  return {
    url: String(url),
    headers: init?.headers as Record<string, string>,
    body: JSON.parse(String(init?.body)) as Record<string, unknown>,
  };
}

describe('parseArgs', () => {
  it('defaults to dev and every live provider', () => {
    expect(parseArgs([])).toEqual({ env: 'dev', providers: ['openai', 'gemini', 'bedrock'] });
    expect(LIVE_PROVIDERS).not.toContain('mock');
  });

  it('reads --env, --provider and --out', () => {
    expect(
      parseArgs(['--env', 'prod', '--provider', 'openai, gemini,openai', '--out', '/x']),
    ).toEqual({ env: 'prod', providers: ['openai', 'gemini'], outDir: '/x' });
  });

  it.each([
    [['--model', 'x'], /Unknown option --model/],
    [['--env'], /--env needs a value/],
    [['--env', '--provider'], /--env needs a value/],
    [['--env', 'staging'], /--env must be one of dev, prod/],
    [['--provider', 'mock'], /--provider must be from openai, gemini, bedrock: mock/],
  ])('rejects %j', (argv, error) => {
    expect(() => parseArgs(argv)).toThrow(error);
  });
});

describe('selectModels', () => {
  const registry = loadSeedRegistry();

  it('picks enabled live models for the environment, in registry order', () => {
    const ids = selectModels(registry, 'dev', LIVE_PROVIDERS).map((model) => model.id);
    expect(ids).toContain('gpt-image-1-mini');
    expect(ids).toContain('gemini-3-pro-image');
    expect(ids).not.toContain('mock');
    expect(ids.indexOf('gpt-image-2')).toBeLessThan(ids.indexOf('gemini-3.1-flash-image'));
  });

  it('filters by provider', () => {
    const models = selectModels(registry, 'dev', ['gemini']);
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model.provider === 'gemini')).toBe(true);
  });

  it('skips disabled models and models from another environment', () => {
    const disabled: ModelConfig = { ...gptMini, enabled: false };
    const devOnly: ModelConfig = { ...gptImage2, environments: ['dev'] };
    expect(selectModels([disabled, devOnly], 'dev', ['openai'])).toEqual([devOnly]);
    expect(selectModels([disabled, devOnly], 'prod', ['openai'])).toEqual([]);
  });
});

describe('cheapestQuality', () => {
  it.each([
    ['gpt-image-2', 'draft'],
    ['gemini-3.1-flash-image', 'standard'],
    ['sd3.5-large', 'standard'],
    ['stable-image-ultra', 'high'],
  ])('%s uses %s', (id, quality) => {
    expect(cheapestQuality(seedModel(id))).toBe(quality);
  });
});

describe('secretName', () => {
  it('follows pictora/<env>/<provider>', () => {
    expect(secretName('dev', 'openai')).toBe('pictora/dev/openai');
    expect(secretName('prod', 'gemini')).toBe('pictora/prod/gemini');
  });
});

describe('OpenAiCheckProvider', () => {
  it('sends the model, size, quality and key, and returns the PNG with its size', async () => {
    const fetchFn = fakeFetch(
      { data: [{ b64_json: pngBase64 }] },
      { headers: { 'x-request-id': 'req-9' } },
    );
    const result = await new OpenAiCheckProvider('sk-test', fetchFn).generate(gptMini, request());

    const call = sent(fetchFn);
    expect(call.url).toBe(`${OPENAI_API_URL}/images/generations`);
    expect(call.headers.authorization).toBe('Bearer sk-test');
    expect(call.body).toEqual({
      model: 'gpt-image-1-mini',
      prompt: 'a lighthouse at dusk',
      size: '1024x1024',
      n: 1,
      output_format: 'png',
      quality: 'low',
    });
    expect(result.images).toEqual([{ png, width: 32, height: 32 }]);
    expect(result.providerRequestId).toBe('req-9');
  });

  it('maps a non-square aspect to the nearest OpenAI size', async () => {
    const fetchFn = fakeFetch({ data: [{ b64_json: pngBase64 }] });
    await new OpenAiCheckProvider('sk-test', fetchFn).generate(
      gptImage2,
      request({ aspect: '16:9' }),
    );
    expect(sent(fetchFn).body.size).toBe('1536x1024');
  });

  it('reports the provider error message and status', async () => {
    const fetchFn = fakeFetch({ error: { message: 'Incorrect API key' } }, { status: 401 });
    await expect(
      new OpenAiCheckProvider('bad', fetchFn).generate(gptMini, request()),
    ).rejects.toMatchObject({ message: 'OpenAI HTTP 401: Incorrect API key', status: 401 });
  });

  it('fails when the response has no image', async () => {
    const fetchFn = fakeFetch({ data: [] });
    await expect(
      new OpenAiCheckProvider('sk-test', fetchFn).generate(gptMini, request()),
    ).rejects.toThrow(ProviderError);
  });

  it('checks moderation with the omni model', async () => {
    const fetchFn = fakeFetch({ results: [{ flagged: false }] });
    const signal = new AbortController().signal;
    await expect(new OpenAiCheckProvider('sk-test', fetchFn).moderate('hi', signal)).resolves.toBe(
      false,
    );
    expect(sent(fetchFn).url).toBe(`${OPENAI_API_URL}/moderations`);
    expect(sent(fetchFn).body).toEqual({ model: OPENAI_MODERATION_MODEL, input: 'hi' });
  });

  it('fails moderation when the response has no result', async () => {
    const fetchFn = fakeFetch({ results: [] });
    await expect(
      new OpenAiCheckProvider('sk-test', fetchFn).moderate('hi', new AbortController().signal),
    ).rejects.toThrow('OpenAI moderation returned no result');
  });
});

describe('GeminiCheckProvider', () => {
  const imageResponse = () => ({
    candidates: [
      {
        content: {
          parts: [
            { text: 'Here you go' },
            { inlineData: { mimeType: 'image/png', data: pngBase64 } },
          ],
        },
        finishReason: 'STOP',
      },
    ],
  });

  it('sends the aspect ratio, image size and key, and returns the PNG', async () => {
    const fetchFn = fakeFetch(imageResponse());
    const result = await new GeminiCheckProvider('g-key', fetchFn).generate(
      geminiFlash,
      request({ quality: 'standard', aspect: '4:5' }),
    );

    const call = sent(fetchFn);
    expect(call.url).toBe(`${GEMINI_API_URL}/models/gemini-3.1-flash-image:generateContent`);
    expect(call.headers['x-goog-api-key']).toBe('g-key');
    expect(call.body).toEqual({
      contents: [{ parts: [{ text: 'a lighthouse at dusk' }] }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio: '4:5', imageSize: '1K' },
      },
    });
    expect(result.images).toEqual([{ png, width: 32, height: 32 }]);
  });

  it('maps a blocked prompt to a safety error', async () => {
    const fetchFn = fakeFetch({ promptFeedback: { blockReason: 'SAFETY' } });
    await expect(
      new GeminiCheckProvider('g-key', fetchFn).generate(geminiLite, request()),
    ).rejects.toThrow(ProviderSafetyError);
  });

  it('maps a safety finish reason to a safety error', async () => {
    const fetchFn = fakeFetch({ candidates: [{ finishReason: 'IMAGE_SAFETY' }] });
    await expect(
      new GeminiCheckProvider('g-key', fetchFn).generate(geminiLite, request()),
    ).rejects.toThrow(ProviderSafetyError);
  });

  it('names the finish reason when no image comes back', async () => {
    const fetchFn = fakeFetch({
      candidates: [{ content: { parts: [{ text: 'no' }] }, finishReason: 'NO_IMAGE' }],
    });
    await expect(
      new GeminiCheckProvider('g-key', fetchFn).generate(geminiLite, request()),
    ).rejects.toThrow('Model gemini-3.1-flash-lite-image returned no image (NO_IMAGE)');
  });

  it('reports an unknown model ID as an HTTP error', async () => {
    const fetchFn = fakeFetch({ error: { message: 'models/x is not found' } }, { status: 404 });
    await expect(
      new GeminiCheckProvider('g-key', fetchFn).generate(geminiLite, request()),
    ).rejects.toMatchObject({ status: 404, message: 'Gemini HTTP 404: models/x is not found' });
  });
});

describe('runChecks', () => {
  /** A clock that moves 1.5 s per reading. */
  function clock() {
    let time = 0;
    return () => (time += 1500);
  }

  function adapter(generate: ImageProvider['generate']): ImageProvider {
    return { generate, edit: () => Promise.reject(new Error('unused')) };
  }

  const ok = (): Promise<ImageResult> =>
    Promise.resolve({ images: [{ png, width: 1024, height: 1024 }], providerCostCents: 1 });

  it('generates one draft image per model with the check prompt, then checks moderation', async () => {
    const generate = vi.fn<ImageProvider['generate']>(ok);
    const moderate = vi.fn(async () => false);
    const results = await runChecks([gptMini, geminiLite], {
      adapters: { openai: adapter(generate), gemini: adapter(generate) },
      moderate,
      now: clock(),
    });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[0]?.[1]).toMatchObject({
      prompt: CHECK_PROMPT,
      aspect: '1:1',
      quality: 'draft',
      count: 1,
    });
    expect(moderate).toHaveBeenCalledWith(CHECK_PROMPT, expect.any(AbortSignal));
    expect(results.map(({ png: image, ...rest }) => ({ ...rest, png: Boolean(image) }))).toEqual([
      {
        name: 'gpt-image-1-mini',
        quality: 'draft',
        ok: true,
        detail: '1024x1024',
        ms: 1500,
        png: true,
      },
      {
        name: 'gemini-3.1-flash-lite-image',
        quality: 'draft',
        ok: true,
        detail: '1024x1024',
        ms: 1500,
        png: true,
      },
      { name: 'openai-moderation', ok: true, detail: 'not flagged', ms: 1500, png: false },
    ]);
  });

  it('records failures and keeps going', async () => {
    const failing = adapter(() =>
      Promise.reject(
        Object.assign(new Error('Gemini HTTP 403: API key not valid'), { status: 403 }),
      ),
    );
    const results = await runChecks([geminiLite, gptMini], {
      adapters: { gemini: failing, openai: adapter(ok) },
      now: clock(),
    });
    expect(results.map((result) => [result.name, result.ok, result.detail])).toEqual([
      ['gemini-3.1-flash-lite-image', false, 'Gemini HTTP 403: API key not valid'],
      ['gpt-image-1-mini', true, '1024x1024'],
    ]);
  });

  it('fails a model with no adapter, and moderation that flags the harmless prompt or errors', async () => {
    const [missing] = await runChecks([gptMini], { adapters: {} });
    expect(missing).toMatchObject({ ok: false, detail: 'No adapter for openai' });

    const flagged = await runChecks([], { adapters: {}, moderate: async () => true });
    expect(flagged[0]).toMatchObject({ ok: false, detail: 'flagged a harmless prompt' });

    const broken = await runChecks([], {
      adapters: {},
      moderate: () => Promise.reject(new Error('OpenAI moderation HTTP 401: bad key')),
    });
    expect(broken[0]).toMatchObject({ ok: false, detail: 'OpenAI moderation HTTP 401: bad key' });
  });
});

describe('formatResults', () => {
  it('prints one aligned line per check', () => {
    const results: CheckResult[] = [
      { name: 'gpt-image-1-mini', quality: 'draft', ok: true, detail: '1024x1024', ms: 8400 },
      { name: 'openai-moderation', ok: false, detail: 'bad key', ms: 300 },
    ];
    expect(formatResults(results)).toBe(
      [
        'PASS  gpt-image-1-mini   draft  8.4s  1024x1024',
        'FAIL  openai-moderation         0.3s  bad key',
      ].join('\n'),
    );
  });
});
