import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  ServiceUnavailableException,
  ThrottlingException,
  ValidationException,
} from '@aws-sdk/client-bedrock-runtime';
import { ASPECTS } from '@pictora/core';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BedrockProvider, stabilityRequestBody, toBedrockError } from '../src/bedrock.js';
import {
  ProviderError,
  ProviderRateLimitError,
  ProviderSafetyError,
  ProviderTimeoutError,
} from '../src/errors.js';
import { createProviderFactory } from '../src/factory.js';
import type { ImageProvider } from '../src/types.js';
import { request, seedModel, solidImage } from './helpers.js';

const core = seedModel('stable-image-core');
const large = seedModel('sd3.5-large');
const ultra = seedModel('stable-image-ultra');

const bedrock = mockClient(BedrockRuntimeClient);
const provider = new BedrockProvider({ client: new BedrockRuntimeClient({ region: 'us-west-2' }) });

let png: Uint8Array;
let jpeg: Uint8Array;
beforeAll(async () => {
  png = await solidImage('png', 64, 48);
  jpeg = await solidImage('jpeg', 40, 30);
});
afterEach(() => bedrock.reset());

/** A Stability response body, as `InvokeModel` returns it. */
function stabilityResponse(
  body: { images?: string[]; seeds?: number[]; finish_reasons?: (string | null)[] },
  requestId = 'req-1',
) {
  return {
    body: new TextEncoder().encode(JSON.stringify(body)) as never,
    contentType: 'application/json',
    $metadata: { requestId },
  };
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/** The JSON body of each `InvokeModel` call so far. */
function sentBodies(): Record<string, unknown>[] {
  return bedrock
    .commandCalls(InvokeModelCommand)
    .map((call) => JSON.parse(String(call.args[0].input.body)));
}

describe('stabilityRequestBody', () => {
  it.each(ASPECTS)('sends aspect %s natively as aspect_ratio, with PNG output', (aspect) => {
    for (const [model, quality] of [
      [core, 'draft'],
      [large, 'standard'],
      [ultra, 'high'],
    ] as const) {
      expect(stabilityRequestBody(model, request({ aspect, quality }))).toMatchObject({
        aspect_ratio: aspect,
        output_format: 'png',
      });
    }
  });

  it('sets text-to-image mode for SD 3.5 Large only', () => {
    expect(stabilityRequestBody(large, request({ quality: 'standard' }))).toEqual({
      prompt: 'a lighthouse at dusk',
      mode: 'text-to-image',
      aspect_ratio: '1:1',
      output_format: 'png',
    });
    expect(stabilityRequestBody(core, request())).toEqual({
      prompt: 'a lighthouse at dusk',
      aspect_ratio: '1:1',
      output_format: 'png',
    });
    expect(stabilityRequestBody(ultra, request({ quality: 'high' }))).not.toHaveProperty('mode');
  });

  it('passes the avoid field as negative_prompt, and the seed, offset per image', () => {
    const req = request({ negativePrompt: '  blurry, text ', seed: 42 });
    expect(stabilityRequestBody(core, req, 0)).toMatchObject({
      negative_prompt: 'blurry, text',
      seed: 42,
    });
    expect(stabilityRequestBody(core, req, 3)).toMatchObject({ seed: 45 });
  });

  it('wraps a seed past the Stability maximum, and leaves out an empty negative prompt', () => {
    const body = stabilityRequestBody(
      core,
      request({ seed: 4_294_967_294, negativePrompt: ' ' }),
      1,
    );
    expect(body.seed).toBe(0);
    expect(body).not.toHaveProperty('negative_prompt');
  });
});

describe('BedrockProvider.generate', () => {
  it('invokes the Bedrock model ID with a JSON body and returns the PNG with its size and seed', async () => {
    bedrock
      .on(InvokeModelCommand)
      .resolves(
        stabilityResponse({ images: [base64(png)], seeds: [1234], finish_reasons: [null] }),
      );
    const result = await provider.generate(
      ultra,
      request({ quality: 'high', aspect: '16:9', negativePrompt: 'fog' }),
    );

    const [call] = bedrock.commandCalls(InvokeModelCommand);
    expect(call?.args[0].input).toMatchObject({
      modelId: 'stability.stable-image-ultra-v1:1',
      contentType: 'application/json',
      accept: 'application/json',
    });
    expect(sentBodies()).toEqual([
      {
        prompt: 'a lighthouse at dusk',
        aspect_ratio: '16:9',
        output_format: 'png',
        negative_prompt: 'fog',
      },
    ]);
    expect(result.images).toHaveLength(1);
    expect(Buffer.from(result.images[0]?.png ?? []).equals(Buffer.from(png))).toBe(true);
    expect(result.images[0]).toMatchObject({ width: 64, height: 48, seed: 1234 });
    expect(result.providerRequestId).toBe('req-1');
    expect(result.providerCostCents).toBe(14);
  });

  it('makes one call per image and charges list price for each', async () => {
    bedrock.on(InvokeModelCommand).resolves(stabilityResponse({ images: [base64(png)] }));
    const result = await provider.generate(
      large,
      request({ quality: 'standard', count: 3, seed: 7 }),
    );
    expect(result.images).toHaveLength(3);
    expect(result.providerCostCents).toBe(24);
    expect(sentBodies().map((body) => body.seed)).toEqual([7, 8, 9]);
    expect(sentBodies().every((body) => body.mode === 'text-to-image')).toBe(true);
  });

  it('converts a non-PNG image to PNG', async () => {
    bedrock.on(InvokeModelCommand).resolves(stabilityResponse({ images: [base64(jpeg)] }));
    const result = await provider.generate(core, request());
    expect(
      Buffer.from(result.images[0]?.png ?? [])
        .subarray(1, 4)
        .toString(),
    ).toBe('PNG');
    expect(result.images[0]).toMatchObject({ width: 40, height: 30 });
  });

  it('maps a content-filter finish reason to ProviderSafetyError', async () => {
    bedrock
      .on(InvokeModelCommand)
      .resolves(stabilityResponse({ images: [''], finish_reasons: ['Filter reason: prompt'] }));
    await expect(provider.generate(core, request())).rejects.toBeInstanceOf(ProviderSafetyError);
  });

  it('maps a content-filter validation error to ProviderSafetyError', async () => {
    bedrock.on(InvokeModelCommand).rejects(
      new ValidationException({
        message: 'Your request was flagged by our content moderation system',
        $metadata: {},
      }),
    );
    await expect(provider.generate(core, request())).rejects.toBeInstanceOf(ProviderSafetyError);
  });

  it('returns the images that succeeded and charges only for them', async () => {
    bedrock
      .on(InvokeModelCommand)
      .resolvesOnce(stabilityResponse({ images: [base64(png)] }, 'req-a'))
      .rejectsOnce(new ServiceUnavailableException({ message: 'busy', $metadata: {} }))
      .resolvesOnce(stabilityResponse({ images: [base64(png)] }, 'req-c'));
    const result = await provider.generate(core, request({ count: 3 }));
    expect(result.images).toHaveLength(2);
    expect(result.providerCostCents).toBe(8);
    expect(result.providerRequestId).toBe('req-a,req-c');
  });

  it('prefers the safety refusal when every image fails', async () => {
    bedrock
      .on(InvokeModelCommand)
      .rejectsOnce(new ThrottlingException({ message: 'slow down', $metadata: {} }))
      .resolvesOnce(stabilityResponse({ images: [''], finish_reasons: ['Filter reason: output'] }));
    await expect(provider.generate(core, request({ count: 2 }))).rejects.toBeInstanceOf(
      ProviderSafetyError,
    );
  });

  it('rejects a response with no image', async () => {
    bedrock.on(InvokeModelCommand).resolves(stabilityResponse({ images: [] }));
    await expect(provider.generate(core, request())).rejects.toThrow(/returned no image/);
  });

  it('rejects a response that is not JSON', async () => {
    bedrock.on(InvokeModelCommand).resolves({
      body: new TextEncoder().encode('<html>') as never,
      $metadata: {},
    });
    await expect(provider.generate(core, request())).rejects.toThrow(/not JSON/);
  });

  it('rejects a quality the model does not offer, without calling Bedrock', async () => {
    await expect(provider.generate(core, request({ quality: 'high' }))).rejects.toThrow(
      /has no high quality/,
    );
    expect(bedrock.commandCalls(InvokeModelCommand)).toHaveLength(0);
  });
});

describe('BedrockProvider.edit', () => {
  it('is not supported by these models', async () => {
    const adapter: ImageProvider = provider;
    await expect(adapter.edit(core, request({ inputImage: png }))).rejects.toThrow(
      /does not support edit/,
    );
  });
});

describe('toBedrockError', () => {
  it('maps throttling and quota errors to ProviderRateLimitError', () => {
    expect(
      toBedrockError(new ThrottlingException({ message: 'Too many requests', $metadata: {} })),
    ).toBeInstanceOf(ProviderRateLimitError);
    expect(
      toBedrockError(Object.assign(new Error('quota'), { name: 'ServiceQuotaExceededException' })),
    ).toBeInstanceOf(ProviderRateLimitError);
  });

  it('maps a validation error to a non-retryable ProviderError', () => {
    const error = toBedrockError(
      new ValidationException({ message: 'Malformed input request', $metadata: {} }),
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).not.toBeInstanceOf(ProviderSafetyError);
    expect(error.retryable).toBe(false);
    expect(error.status).toBe(400);
  });

  it('marks service-side failures retryable', () => {
    for (const name of [
      'ServiceUnavailableException',
      'InternalServerException',
      'ModelTimeoutException',
    ]) {
      expect(toBedrockError(Object.assign(new Error(name), { name })).retryable).toBe(true);
    }
  });

  it('maps an abort to ProviderTimeoutError', () => {
    expect(
      toBedrockError(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    ).toBeInstanceOf(ProviderTimeoutError);
  });
});

describe('createProviderFactory', () => {
  it('picks the Bedrock adapter for the Stability models by default', () => {
    const providerFor = createProviderFactory();
    expect(providerFor(core)).toBe(providerFor(ultra));
  });

  it('retries a throttled call once', async () => {
    bedrock
      .on(InvokeModelCommand)
      .rejectsOnce(new ThrottlingException({ message: 'slow down', $metadata: {} }))
      .resolves(stabilityResponse({ images: [base64(png)] }));
    const providerFor = createProviderFactory({
      adapters: { bedrock: () => provider },
      retry: { delayMs: 1, jitterMs: 0 },
    });
    const result = await providerFor(core).generate(core, request());
    expect(result.images).toHaveLength(1);
    expect(bedrock.commandCalls(InvokeModelCommand)).toHaveLength(2);
  });
});
