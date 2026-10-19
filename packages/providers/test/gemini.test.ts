import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { http, HttpResponse, type JsonBodyType } from 'msw';
import { setupServer } from 'msw/node';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ProviderError,
  ProviderRateLimitError,
  ProviderSafetyError,
  ProviderTimeoutError,
} from '../src/errors.js';
import { guardProvider } from '../src/factory.js';
import {
  GEMINI_DEFAULT_VERTEX_LOCATION,
  GeminiProvider,
  geminiClientOptions,
  geminiConfigFromEnv,
  geminiRequest,
  toGeminiError,
  type GeminiConfig,
} from '../src/gemini.js';
import { request, seedModel, solidImage } from './helpers.js';

const BASE_URL = 'https://gemini.test';
const GENERATE_URL = /^https:\/\/gemini\.test\/v1beta\/models\/([^/:]+):generateContent$/;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const flash = seedModel('gemini-3.1-flash-image');
const lite = seedModel('gemini-3.1-flash-lite-image');
const pro = seedModel('gemini-3-pro-image');

const API: GeminiConfig = { backend: 'api' };

/** A recorded response from `fixtures/gemini`, with each image placeholder replaced by `image`. */
function fixture(name: string, image?: Uint8Array): JsonBodyType {
  const text = readFileSync(new URL(`./fixtures/gemini/${name}.json`, import.meta.url), 'utf8');
  return JSON.parse(
    image ? text.replaceAll('__IMAGE__', Buffer.from(image).toString('base64')) : text,
  ) as JsonBodyType;
}

function provider(credential = async () => 'g-key') {
  return new GeminiProvider({ config: API, credential, baseUrl: BASE_URL });
}

interface Seen {
  model: string;
  apiKey: string | null;
  body: {
    contents: { role: string; parts: Record<string, unknown>[] }[];
    generationConfig: Record<string, unknown>;
  };
}

/** Answers each call with the next response in `responses` (the last one repeats), recording requests. */
function onGenerate(...responses: (() => Response)[]) {
  const seen: Seen[] = [];
  server.use(
    http.post(GENERATE_URL, async ({ request: req }) => {
      const model = /models\/([^/:]+):/.exec(req.url)?.[1] ?? '';
      seen.push({
        model,
        apiKey: req.headers.get('x-goog-api-key'),
        body: (await req.json()) as Seen['body'],
      });
      const respond = responses[Math.min(seen.length, responses.length) - 1];
      return respond!();
    }),
  );
  return seen;
}

const ok =
  (image: Uint8Array, name = 'generate_image') =>
  () =>
    HttpResponse.json(fixture(name, image));
const failure = (status: number, name: string) => () =>
  HttpResponse.json(fixture(name), { status });

describe('GeminiProvider.generate', () => {
  it('sends the prompt with an image-only response, the aspect ratio and the size tier', async () => {
    const png = await solidImage('png', 1376, 768);
    const seen = onGenerate(ok(png));

    const result = await provider().generate(
      flash,
      request({ aspect: '16:9', quality: 'standard' }),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.model).toBe('gemini-3.1-flash-image');
    expect(seen[0]?.apiKey).toBe('g-key');
    expect(seen[0]?.body.contents).toEqual([
      { role: 'user', parts: [{ text: 'a lighthouse at dusk' }] },
    ]);
    expect(seen[0]?.body.generationConfig).toEqual({
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: '16:9', imageSize: '1K' },
    });
    expect(result.images).toEqual([{ png, width: 1376, height: 768 }]);
    expect(result.providerRequestId).toBe('resp-gen-1');
    expect(result.providerCostCents).toBe(7);
  });

  it.each([
    [flash, 'standard', '1K', 7],
    [flash, 'high', '2K', 11],
    [lite, 'draft', '1K', 4],
    [pro, 'standard', '2K', 14],
    [pro, 'high', '4K', 24],
  ] as const)(
    'sends %s at %s quality as %s and charges the registry price',
    async (model, quality, imageSize, cents) => {
      const seen = onGenerate(ok(await solidImage('png', 64, 64)));
      const result = await provider().generate(model, request({ quality }));
      expect(seen[0]?.model).toBe(model.providerModelId);
      expect(seen[0]?.body.generationConfig.imageConfig).toEqual({
        aspectRatio: '1:1',
        imageSize,
      });
      expect(result.providerCostCents).toBe(cents);
    },
  );

  it.each(['1:1', '4:5', '3:2', '2:3', '16:9', '9:16'] as const)(
    'sends the %s aspect natively',
    async (aspect) => {
      const seen = onGenerate(ok(await solidImage('png', 64, 64)));
      await provider().generate(lite, request({ aspect }));
      expect(seen[0]?.body.generationConfig.imageConfig).toMatchObject({ aspectRatio: aspect });
    },
  );

  it('converts a JPEG response to PNG, keeping its size', async () => {
    onGenerate(ok(await solidImage('jpeg', 928, 1152)));
    const result = await provider().generate(lite, request({ aspect: '4:5' }));
    const meta = await sharp(result.images[0]?.png).metadata();
    expect(meta).toMatchObject({ format: 'png', width: 928, height: 1152 });
    expect(result.images[0]).toMatchObject({ width: 928, height: 1152 });
  });

  it('makes one call per image and charges for each', async () => {
    const seen = onGenerate(ok(await solidImage('png', 64, 64)));
    const result = await provider().generate(flash, request({ quality: 'standard', count: 3 }));
    expect(seen).toHaveLength(3);
    expect(result.images).toHaveLength(3);
    expect(result.providerCostCents).toBe(21);
    expect(result.providerRequestId).toBe('resp-gen-1,resp-gen-1,resp-gen-1');
  });

  it('returns and charges only the images that came back when some calls fail', async () => {
    const png = await solidImage('png', 64, 64);
    onGenerate(ok(png), failure(500, 'error_server'), ok(png));
    const result = await provider().generate(flash, request({ quality: 'high', count: 3 }));
    expect(result.images).toHaveLength(2);
    expect(result.providerCostCents).toBe(22);
  });

  it('throws when every call fails, preferring a safety refusal', async () => {
    onGenerate(failure(500, 'error_server'), () => HttpResponse.json(fixture('image_safety')));
    await expect(
      provider().generate(flash, request({ quality: 'standard', count: 3 })),
    ).rejects.toBeInstanceOf(ProviderSafetyError);
  });

  it('rejects a quality or count the model does not offer before calling Gemini', async () => {
    await expect(provider().generate(lite, request({ quality: 'high' }))).rejects.toThrow(
      'Model gemini-3.1-flash-lite-image has no high quality',
    );
    await expect(provider().generate(lite, request({ count: 0 }))).rejects.toThrow(
      'Image count must be 1–4: 0',
    );
  });

  it('reports credentials that cannot be read as a provider error', async () => {
    const failing = provider(() => Promise.reject(new Error('AccessDenied')));
    await expect(failing.generate(lite, request())).rejects.toThrow(
      'The Gemini credentials could not be read',
    );
  });

  it('reads the credential on every call, so a rotated key is picked up', async () => {
    const seen = onGenerate(ok(await solidImage('png', 64, 64)));
    const keys = ['g-one', 'g-two'];
    const rotating = provider(async () => keys.shift() ?? 'g-none');
    await rotating.generate(lite, request());
    await rotating.generate(lite, request());
    expect(seen.map((call) => call.apiKey)).toEqual(['g-one', 'g-two']);
  });
});

describe('GeminiProvider.edit', () => {
  it('sends the parent image, then the references, then the instruction, with no history', async () => {
    const parent = await solidImage('png', 1024, 1024);
    const references = [await solidImage('jpeg', 32, 32), await solidImage('webp', 32, 32)];
    const seen = onGenerate(ok(parent, 'edit_image'));

    const result = await provider().edit(
      flash,
      request({
        prompt: 'make the sky stormy',
        quality: 'standard',
        inputImage: parent,
        referenceImages: references,
      }),
    );

    expect(seen[0]?.body.contents).toEqual([
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/png', data: Buffer.from(parent).toString('base64') } },
          {
            inlineData: {
              mimeType: 'image/jpeg',
              data: Buffer.from(references[0]!).toString('base64'),
            },
          },
          {
            inlineData: {
              mimeType: 'image/webp',
              data: Buffer.from(references[1]!).toString('base64'),
            },
          },
          { text: 'make the sky stormy' },
        ],
      },
    ]);
    expect(seen[0]?.body.generationConfig).toEqual({
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: '1:1', imageSize: '1K' },
    });
    expect(result.images).toEqual([{ png: parent, width: 1024, height: 1024 }]);
    expect(result.providerRequestId).toBe('resp-edit-1');
    expect(result.providerCostCents).toBe(7);
  });

  it('needs a parent image and at most 3 references', async () => {
    await expect(provider().edit(flash, request({ quality: 'standard' }))).rejects.toThrow(
      'An edit with model gemini-3.1-flash-image needs an image',
    );
    const png = await solidImage('png', 8, 8);
    await expect(
      provider().edit(
        flash,
        request({ quality: 'standard', inputImage: png, referenceImages: [png, png, png, png] }),
      ),
    ).rejects.toThrow('Model gemini-3.1-flash-image takes at most 3 reference images: 4');
  });

  it('refuses a model without edit support', async () => {
    const generateOnly = { ...lite, capabilities: { ...lite.capabilities, edit: false } };
    await expect(
      provider().edit(generateOnly, request({ inputImage: await solidImage('png', 8, 8) })),
    ).rejects.toThrow('Model gemini-3.1-flash-lite-image does not support edit');
  });
});

describe('Gemini safety and error mapping', () => {
  it.each([
    ['blocked_prompt', 'Gemini blocked the prompt: PROHIBITED_CONTENT'],
    ['image_safety', 'Gemini stopped the image: IMAGE_SAFETY'],
    ['safety_rating_blocked', 'Gemini blocked the image: HARM_CATEGORY_SEXUALLY_EXPLICIT'],
  ])('maps %s to ProviderSafetyError', async (name, message) => {
    onGenerate(() => HttpResponse.json(fixture(name)));
    const error = await provider()
      .generate(lite, request())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderSafetyError);
    expect(error).toMatchObject({ message, retryable: false });
  });

  it('names the finish reason when no image comes back', async () => {
    onGenerate(() => HttpResponse.json(fixture('no_image')));
    const error = await provider()
      .generate(lite, request())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).not.toBeInstanceOf(ProviderSafetyError);
    expect(error).toMatchObject({
      message: 'Model gemini-3.1-flash-lite-image returned no image (NO_IMAGE)',
    });
  });

  it('maps a 429 to ProviderRateLimitError and retries it once', async () => {
    const seen = onGenerate(failure(429, 'error_rate_limit'));
    const guarded = guardProvider(provider(), { delayMs: 0, jitterMs: 0 });
    const error = await guarded.generate(lite, request()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(error).toMatchObject({ status: 429 });
    expect(seen).toHaveLength(2);
  });

  it('maps a 500 to a retryable ProviderError, and succeeds when the retry works', async () => {
    const seen = onGenerate(failure(500, 'error_server'), ok(await solidImage('png', 64, 64)));
    const guarded = guardProvider(provider(), { delayMs: 0, jitterMs: 0 });
    const result = await guarded.generate(lite, request());
    expect(result.images).toHaveLength(1);
    expect(seen).toHaveLength(2);
  });

  it('maps a 400 to a non-retryable ProviderError', async () => {
    const seen = onGenerate(failure(400, 'error_bad_request'));
    const guarded = guardProvider(provider(), { delayMs: 0, jitterMs: 0 });
    const error = await guarded.generate(lite, request()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ status: 400, retryable: false });
    expect(seen).toHaveLength(1);
  });

  it('maps a 400 that names the safety filter to ProviderSafetyError', () => {
    const error = Object.assign(new Error('The input image was blocked by safety filters'), {
      status: 400,
    });
    expect(toGeminiError(error)).toBeInstanceOf(ProviderSafetyError);
  });

  it('maps an aborted call to ProviderTimeoutError', async () => {
    server.use(
      http.post(GENERATE_URL, async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return HttpResponse.json({});
      }),
    );
    const controller = new AbortController();
    const pending = provider().generate(lite, request({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toBeInstanceOf(ProviderTimeoutError);
  });
});

describe('geminiRequest', () => {
  it('leaves out the size tier when the registry quality has none', () => {
    const noSize = { ...lite, qualities: { draft: { providerParams: {}, costPoints: 4 } } };
    expect(geminiRequest(noSize, request()).config.imageConfig).toEqual({ aspectRatio: '1:1' });
  });
});

describe('Gemini backends', () => {
  const serviceAccount = JSON.stringify({
    type: 'service_account',
    project_id: 'pictora-sa-project',
    client_email: 'pictora@pictora-sa-project.iam.gserviceaccount.com',
    // A throwaway key, so the auth library can sign its token request; the token endpoint is mocked.
    private_key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    }),
  });

  it('reads the backend from GEMINI_BACKEND, defaulting to the Gemini API', () => {
    expect(geminiConfigFromEnv({})).toEqual({ backend: 'api' });
    expect(geminiConfigFromEnv({ GEMINI_BACKEND: 'api' })).toEqual({ backend: 'api' });
    expect(
      geminiConfigFromEnv({
        GEMINI_BACKEND: 'vertex',
        GEMINI_VERTEX_PROJECT: 'pictora-gcp',
        GEMINI_VERTEX_LOCATION: 'us-central1',
      }),
    ).toEqual({ backend: 'vertex', project: 'pictora-gcp', location: 'us-central1' });
    expect(geminiConfigFromEnv({ GEMINI_BACKEND: 'vertex' })).toEqual({
      backend: 'vertex',
      project: undefined,
      location: GEMINI_DEFAULT_VERTEX_LOCATION,
    });
    expect(() => geminiConfigFromEnv({ GEMINI_BACKEND: 'openai' })).toThrow(
      'GEMINI_BACKEND must be one of api, vertex: openai',
    );
  });

  it('builds a Gemini API client from the API key', () => {
    expect(geminiClientOptions(API, ' g-key\n')).toEqual({
      apiKey: 'g-key',
      httpOptions: { timeout: 120_000, retryOptions: { attempts: 1 } },
    });
  });

  it('builds a Vertex AI client from the service account key, with the project from config or the key', () => {
    const options = geminiClientOptions(
      { backend: 'vertex', project: 'pictora-gcp', location: 'us-central1' },
      serviceAccount,
    );
    expect(options).toMatchObject({
      vertexai: true,
      project: 'pictora-gcp',
      location: 'us-central1',
      googleAuthOptions: {
        credentials: JSON.parse(serviceAccount),
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      },
      httpOptions: { timeout: 120_000, retryOptions: { attempts: 1 } },
    });
    expect(options).not.toHaveProperty('apiKey');
    expect(geminiClientOptions({ backend: 'vertex' }, serviceAccount)).toMatchObject({
      project: 'pictora-sa-project',
      location: GEMINI_DEFAULT_VERTEX_LOCATION,
    });
  });

  it('rejects a Vertex AI secret that is not a service account key, or has no project', () => {
    expect(() => geminiClientOptions({ backend: 'vertex' }, 'g-key')).toThrow(
      'The Gemini secret must hold a service account key JSON for Vertex AI',
    );
    expect(() => geminiClientOptions({ backend: 'vertex' }, '{"type":"service_account"}')).toThrow(
      'Vertex AI needs a project: set GEMINI_VERTEX_PROJECT',
    );
    expect(() => geminiClientOptions(API, '  ')).toThrow('The Gemini secret is empty');
  });

  it('calls the Vertex AI endpoint for the project and location with the same request', async () => {
    let seen: { url: string; auth: string | null; body: unknown } | undefined;
    server.use(
      http.post('https://oauth2.googleapis.com/token', () =>
        HttpResponse.json({ access_token: 'ya29.test', expires_in: 3600, token_type: 'Bearer' }),
      ),
      http.post(
        /^https:\/\/us-central1-aiplatform\.googleapis\.com\/.*:generateContent$/,
        async ({ request: req }) => {
          seen = { url: req.url, auth: req.headers.get('authorization'), body: await req.json() };
          return HttpResponse.json(fixture('generate_image', png));
        },
      ),
    );
    const png = await solidImage('png', 64, 64);
    const vertex = new GeminiProvider({
      config: { backend: 'vertex', project: 'pictora-gcp', location: 'us-central1' },
      credential: async () => serviceAccount,
    });
    const result = await vertex.generate(lite, request());
    expect(seen?.url).toContain(
      '/projects/pictora-gcp/locations/us-central1/publishers/google/models/gemini-3.1-flash-lite-image:generateContent',
    );
    expect(seen?.auth).toBe('Bearer ya29.test');
    expect(result.images).toHaveLength(1);
  });
});
