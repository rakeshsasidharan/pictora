import { loadSeedRegistry } from '@pictora/core';
import { readFileSync } from 'node:fs';
import { http, HttpResponse, type JsonBodyType } from 'msw';
import { setupServer } from 'msw/node';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ProviderError,
  ProviderRateLimitError,
  ProviderSafetyError,
  ProviderTimeoutError,
} from '../src/errors.js';
import { guardProvider } from '../src/factory.js';
import {
  OPENAI_TOKEN_PRICES,
  OpenAiProvider,
  openAiCostCents,
  openAiRequestParams,
  toOpenAiError,
} from '../src/openai.js';
import { request, seedModel, solidImage } from './helpers.js';

const BASE_URL = 'https://openai.test/v1';
const GENERATE_URL = `${BASE_URL}/images/generations`;
const EDIT_URL = `${BASE_URL}/images/edits`;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const gptImage2 = seedModel('gpt-image-2');
const gptMini = seedModel('gpt-image-1-mini');

/** A recorded response from `fixtures/openai`, with each image placeholder replaced by `image`. */
function fixture(name: string, image?: Uint8Array): JsonBodyType {
  const text = readFileSync(new URL(`./fixtures/openai/${name}.json`, import.meta.url), 'utf8');
  return JSON.parse(
    image ? text.replaceAll('__IMAGE__', Buffer.from(image).toString('base64')) : text,
  );
}

function provider(apiKey = async () => 'sk-test') {
  return new OpenAiProvider({ apiKey, baseURL: BASE_URL });
}

/** A PNG whose pixels are all fully transparent, as OpenAI returns for `background: 'transparent'`. */
async function transparentPng(width: number, height: number): Promise<Uint8Array> {
  const image = sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  });
  return new Uint8Array(await image.png().toBuffer());
}

interface Seen {
  auth: string | null;
  body: Record<string, unknown>;
}

/** Answers generate calls with a fixture, recording each request's JSON body. */
function onGenerate(name: string, image: Uint8Array, headers: Record<string, string> = {}) {
  const seen: Seen[] = [];
  server.use(
    http.post(GENERATE_URL, async ({ request: req }) => {
      seen.push({
        auth: req.headers.get('authorization'),
        body: (await req.json()) as Record<string, unknown>,
      });
      return HttpResponse.json(fixture(name, image), { headers });
    }),
  );
  return seen;
}

function onError(url: string, status: number, name: string) {
  const calls = vi.fn();
  server.use(
    http.post(url, () => {
      calls();
      return HttpResponse.json(fixture(name), {
        status,
        headers: { 'x-request-id': 'req_err' },
      });
    }),
  );
  return calls;
}

describe('OpenAiProvider.generate', () => {
  it('sends the model, PNG output, quality, size and count, and returns the images', async () => {
    const png = await solidImage('png', 1024, 1024);
    const seen = onGenerate('generate_gpt_image_2', png, { 'x-request-id': 'req_abc123' });

    const result = await provider().generate(gptImage2, request({ quality: 'standard' }));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.auth).toBe('Bearer sk-test');
    expect(seen[0]?.body).toEqual({
      model: 'gpt-image-2',
      prompt: 'a lighthouse at dusk',
      output_format: 'png',
      quality: 'medium',
      size: '1024x1024',
      n: 1,
    });
    expect(result.images).toEqual([{ png, width: 1024, height: 1024 }]);
    expect(result.providerRequestId).toBe('req_abc123');
  });

  it.each([
    ['draft', 'low'],
    ['standard', 'medium'],
    ['high', 'high'],
  ] as const)('maps GPT Image 2 %s quality to %s', async (quality, expected) => {
    const seen = onGenerate('generate_gpt_image_2', await solidImage('png', 1024, 1024));
    await provider().generate(gptImage2, request({ quality }));
    expect(seen[0]?.body.quality).toBe(expected);
  });

  it('sends GPT Image 1 Mini at low quality with n for several images', async () => {
    const png = await solidImage('png', 1536, 1024);
    const seen = onGenerate('generate_gpt_image_1_mini', png);
    const result = await provider().generate(gptMini, request({ aspect: '3:2', count: 2 }));
    expect(seen[0]?.body).toMatchObject({
      model: 'gpt-image-1-mini',
      quality: 'low',
      size: '1536x1024',
      n: 2,
    });
    expect(result.images).toHaveLength(2);
  });

  it.each([
    ['1:1', '1024x1024', 1024, 1024],
    ['3:2', '1536x1024', 1536, 1024],
    ['2:3', '1024x1536', 1024, 1536],
    ['16:9', '1536x1024', 1536, 864],
    ['9:16', '1024x1536', 864, 1536],
    ['4:5', '1024x1536', 1024, 1280],
  ] as const)('generates %s at %s and returns %ix%i', async (aspect, size, width, height) => {
    const [w, h] = size.split('x').map(Number) as [number, number];
    const seen = onGenerate('generate_gpt_image_2', await solidImage('png', w, h));
    const result = await provider().generate(gptImage2, request({ aspect }));
    expect(seen[0]?.body.size).toBe(size);
    expect(result.images[0]).toMatchObject({ width, height });
    const meta = await sharp(result.images[0]?.png).metadata();
    expect(meta).toMatchObject({ format: 'png', width, height });
  });

  it('asks for a transparent background when requested and keeps the alpha channel', async () => {
    const seen = onGenerate('generate_gpt_image_2', await transparentPng(1536, 1024));
    const result = await provider().generate(
      gptImage2,
      request({ aspect: '16:9', transparentBackground: true }),
    );
    expect(seen[0]?.body.background).toBe('transparent');
    const meta = await sharp(result.images[0]?.png).metadata();
    expect(meta.hasAlpha).toBe(true);
    expect(meta).toMatchObject({ width: 1536, height: 864 });
  });

  it('leaves the background unset when no transparency is asked for', async () => {
    const seen = onGenerate('generate_gpt_image_2', await solidImage('png', 1024, 1024));
    await provider().generate(gptImage2, request({ transparentBackground: false }));
    expect(seen[0]?.body).not.toHaveProperty('background');
  });

  it('converts a non-PNG response to PNG', async () => {
    onGenerate('generate_gpt_image_2', await solidImage('webp', 1024, 1024));
    const result = await provider().generate(gptImage2, request());
    expect((await sharp(result.images[0]?.png).metadata()).format).toBe('png');
  });

  it('computes the cost from the usage data', async () => {
    onGenerate('generate_gpt_image_2', await solidImage('png', 1024, 1024));
    const result = await provider().generate(gptImage2, request({ quality: 'standard' }));
    // 18 text tokens at $5/M plus 1,056 image tokens at $30/M = $0.03177.
    expect(result.providerCostCents).toBe(3.18);
  });

  it('falls back to the registry estimate when the response has no usage', async () => {
    const png = await solidImage('png', 1024, 1024);
    const body = { data: [{ b64_json: Buffer.from(png).toString('base64') }] };
    server.use(http.post(GENERATE_URL, () => HttpResponse.json(body)));
    const result = await provider().generate(gptImage2, request({ quality: 'high' }));
    expect(result.providerCostCents).toBe(22);
    expect(result.providerRequestId).toBeUndefined();
  });

  it('fails when the response has no image', async () => {
    server.use(http.post(GENERATE_URL, () => HttpResponse.json({ created: 1, data: [] })));
    await expect(provider().generate(gptImage2, request())).rejects.toThrow(
      'Model gpt-image-2 returned no image',
    );
  });

  it('rejects a quality or count the model does not offer before calling OpenAI', async () => {
    await expect(provider().generate(gptMini, request({ quality: 'high' }))).rejects.toThrow(
      'Model gpt-image-1-mini has no high quality',
    );
    await expect(provider().generate(gptImage2, request({ count: 5 }))).rejects.toThrow(
      'Image count must be 1–4: 5',
    );
  });

  it('reports a key that cannot be read as a provider error', async () => {
    const failing = provider(() => Promise.reject(new Error('AccessDenied')));
    await expect(failing.generate(gptImage2, request())).rejects.toThrow(
      'The OpenAI API key could not be read',
    );
  });

  it('reads the key on every call, so a rotated key is picked up', async () => {
    const seen = onGenerate('generate_gpt_image_2', await solidImage('png', 1024, 1024));
    const keys = ['sk-one', 'sk-two'];
    const rotating = provider(async () => keys.shift() ?? 'sk-none');
    await rotating.generate(gptImage2, request());
    await rotating.generate(gptImage2, request());
    expect(seen.map((call) => call.auth)).toEqual(['Bearer sk-one', 'Bearer sk-two']);
  });
});

describe('OpenAiProvider.edit', () => {
  it('sends the parent PNG first, then the references, with the instruction', async () => {
    const parent = await solidImage('png', 1024, 1536);
    const references = [await solidImage('jpeg', 64, 64), await solidImage('webp', 64, 64)];
    let form: FormData | undefined;
    server.use(
      http.post(EDIT_URL, async ({ request: req }) => {
        form = await req.formData();
        return HttpResponse.json(fixture('edit_gpt_image_2', parent), {
          headers: { 'x-request-id': 'req_edit' },
        });
      }),
    );

    const result = await provider().edit(
      gptImage2,
      request({
        prompt: 'make the sky stormy',
        aspect: '2:3',
        quality: 'high',
        inputImage: parent,
        referenceImages: references,
      }),
    );

    expect(form?.get('model')).toBe('gpt-image-2');
    expect(form?.get('prompt')).toBe('make the sky stormy');
    expect(form?.get('output_format')).toBe('png');
    expect(form?.get('quality')).toBe('high');
    expect(form?.get('size')).toBe('1024x1536');
    expect(form?.get('n')).toBe('1');
    const files = form?.getAll('image[]') as File[];
    expect(files.map((file) => file.type)).toEqual(['image/png', 'image/jpeg', 'image/webp']);
    expect(new Uint8Array(await files[0]!.arrayBuffer())).toEqual(parent);
    expect(result.images).toEqual([{ png: parent, width: 1024, height: 1536 }]);
    expect(result.providerRequestId).toBe('req_edit');
    // 34 text tokens at $5/M, 1,560 image input tokens at $8/M and 6,240 image output tokens at $30/M.
    expect(result.providerCostCents).toBeCloseTo(19.99, 2);
  });

  it('sends a transparent background on edits too', async () => {
    const parent = await transparentPng(1024, 1024);
    let form: FormData | undefined;
    server.use(
      http.post(EDIT_URL, async ({ request: req }) => {
        form = await req.formData();
        return HttpResponse.json(fixture('edit_gpt_image_2', parent));
      }),
    );
    await provider().edit(gptMini, request({ inputImage: parent, transparentBackground: true }));
    expect(form?.get('background')).toBe('transparent');
    expect(form?.getAll('image[]')).toHaveLength(1);
  });

  it('needs a parent image and at most 3 references', async () => {
    await expect(provider().edit(gptImage2, request())).rejects.toThrow(
      'An edit with model gpt-image-2 needs an image',
    );
    const png = await solidImage('png', 8, 8);
    await expect(
      provider().edit(
        gptImage2,
        request({ inputImage: png, referenceImages: [png, png, png, png] }),
      ),
    ).rejects.toThrow('Model gpt-image-2 takes at most 3 reference images: 4');
  });

  it('maps a safety refusal on an edit to ProviderSafetyError', async () => {
    onError(EDIT_URL, 400, 'error_safety');
    const png = await solidImage('png', 8, 8);
    await expect(provider().edit(gptImage2, request({ inputImage: png }))).rejects.toBeInstanceOf(
      ProviderSafetyError,
    );
  });
});

describe('OpenAI error mapping', () => {
  it('maps a safety refusal to ProviderSafetyError, never retried', async () => {
    const calls = onError(GENERATE_URL, 400, 'error_safety');
    const guarded = guardProvider(provider(), { delayMs: 0, jitterMs: 0 });
    const error = await guarded.generate(gptImage2, request()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderSafetyError);
    expect(error).toMatchObject({ status: 400, retryable: false });
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('maps another 400 to a non-retryable ProviderError', async () => {
    const calls = onError(GENERATE_URL, 400, 'error_bad_request');
    const guarded = guardProvider(provider(), { delayMs: 0, jitterMs: 0 });
    const error = await guarded.generate(gptImage2, request()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).not.toBeInstanceOf(ProviderSafetyError);
    expect(error).toMatchObject({ status: 400, retryable: false });
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('maps a 429 to ProviderRateLimitError and retries it once', async () => {
    const calls = onError(GENERATE_URL, 429, 'error_rate_limit');
    const guarded = guardProvider(provider(), { delayMs: 0, jitterMs: 0 });
    const error = await guarded.generate(gptImage2, request()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(error).toMatchObject({ status: 429 });
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('maps a 500 to a retryable ProviderError and retries it once', async () => {
    const calls = onError(GENERATE_URL, 500, 'error_server');
    const guarded = guardProvider(provider(), { delayMs: 0, jitterMs: 0 });
    const error = await guarded.generate(gptImage2, request()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ status: 500, retryable: true });
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('succeeds when the retry after a 500 works', async () => {
    const png = await solidImage('png', 1024, 1024);
    let calls = 0;
    server.use(
      http.post(GENERATE_URL, () =>
        ++calls === 1
          ? HttpResponse.json(fixture('error_server'), { status: 500 })
          : HttpResponse.json(fixture('generate_gpt_image_2', png)),
      ),
    );
    const guarded = guardProvider(provider(), { delayMs: 0, jitterMs: 0 });
    const result = await guarded.generate(gptImage2, request());
    expect(result.images).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('maps a network failure to a retryable ProviderError', async () => {
    server.use(http.post(GENERATE_URL, () => HttpResponse.error()));
    const error = await provider()
      .generate(gptImage2, request())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ retryable: true });
  });

  it('maps an aborted call to ProviderTimeoutError', async () => {
    server.use(
      http.post(GENERATE_URL, async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return HttpResponse.json({});
      }),
    );
    const controller = new AbortController();
    const pending = provider().generate(gptImage2, request({ signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it('passes typed errors through and maps plain errors by status', () => {
    const safety = new ProviderSafetyError('blocked');
    expect(toOpenAiError(safety)).toBe(safety);
    expect(toOpenAiError(Object.assign(new Error('x'), { status: 429 }))).toBeInstanceOf(
      ProviderRateLimitError,
    );
  });
});

describe('openAiRequestParams', () => {
  it('ignores a transparent background on a model without the capability', () => {
    const opaqueOnly = {
      ...gptImage2,
      capabilities: { ...gptImage2.capabilities, transparentBackground: false },
    };
    expect(
      openAiRequestParams(opaqueOnly, request({ transparentBackground: true })),
    ).not.toHaveProperty('background');
  });

  it('needs an OpenAI quality in the registry entry', () => {
    const broken = {
      ...gptMini,
      qualities: { draft: { providerParams: {}, costPoints: 1 } },
    };
    expect(() => openAiRequestParams(broken, request())).toThrow(
      'Model gpt-image-1-mini quality draft has no OpenAI quality',
    );
  });
});

describe('openAiCostCents', () => {
  const usage = {
    input_tokens: 1_000,
    input_tokens_details: { text_tokens: 400, image_tokens: 600 },
    output_tokens: 4_000,
    output_tokens_details: { image_tokens: 3_900, text_tokens: 100 },
    total_tokens: 5_000,
  };

  it('prices each token type at the model rate', () => {
    // GPT Image 2: 400 × $5 + 600 × $8 + 3,900 × $30 + 100 × $10, per million = $0.1248.
    expect(openAiCostCents(gptImage2, 'standard', usage, 1)).toBe(12.48);
    // GPT Image 1 Mini: 400 × $2 + 600 × $2.50 + 3,900 × $8 + 100 × $8, per million = $0.0343.
    expect(openAiCostCents(gptMini, 'draft', usage, 1)).toBe(3.43);
  });

  it('counts all output tokens as image tokens when there is no breakdown', () => {
    const { output_tokens_details: _, ...plain } = usage;
    void _;
    // 400 × $2 + 600 × $2.50 + 4,000 × $8, per million = $0.0343.
    expect(openAiCostCents(gptMini, 'draft', plain, 1)).toBe(3.43);
  });

  it('falls back to the registry estimate without usage or prices', () => {
    expect(openAiCostCents(gptImage2, 'high', undefined, 3)).toBe(66);
    expect(openAiCostCents(gptImage2, 'standard', usage, 2, {})).toBe(12);
  });

  it('has prices for every OpenAI model in the registry', () => {
    for (const model of loadSeedRegistry().filter((entry) => entry.provider === 'openai')) {
      expect(OPENAI_TOKEN_PRICES[model.providerModelId]).toBeDefined();
    }
  });
});
