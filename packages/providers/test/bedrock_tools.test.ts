import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  ThrottlingException,
  ValidationException,
} from '@aws-sdk/client-bedrock-runtime';
import type { ToolId } from '@pictora/core';
import { mockClient } from 'aws-sdk-client-mock';
import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BedrockProvider, stabilityToolBody } from '../src/bedrock.js';
import { ProviderError, ProviderSafetyError } from '../src/errors.js';
import { createProviderFactory } from '../src/factory.js';
import { prepareMask, prepareToolImage, ToolInputError } from '../src/image.js';
import type { ToolRequest } from '../src/types.js';
import { seedModel, solidImage } from './helpers.js';

const bedrock = mockClient(BedrockRuntimeClient);
const provider = new BedrockProvider({ client: new BedrockRuntimeClient({ region: 'us-west-2' }) });

let png: Uint8Array;
let transparent: Uint8Array;
beforeAll(async () => {
  png = await solidImage('png', 64, 48);
  transparent = new Uint8Array(
    await sharp({
      create: { width: 64, height: 48, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer(),
  );
});
afterEach(() => bedrock.reset());

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

function response(body: Record<string, unknown>, requestId = 'req-tool') {
  return {
    body: new TextEncoder().encode(JSON.stringify(body)) as never,
    contentType: 'application/json',
    $metadata: { requestId },
  };
}

function toolRequest(tool: ToolId, overrides: Partial<ToolRequest> = {}): ToolRequest {
  return { tool, image: png, signal: new AbortController().signal, ...overrides };
}

/** Each tool's registry model, as the worker picks it for a user outside the testers group. */
const MODELS: Record<ToolId, string> = {
  'upscale-fast': 'stable-fast-upscale',
  'upscale-conservative': 'stable-conservative-upscale',
  'upscale-creative': 'stable-creative-upscale',
  'remove-background': 'stable-image-remove-background',
  erase: 'stable-image-erase-object',
  outpaint: 'stable-outpaint',
};

describe('stabilityToolBody', () => {
  it('sends the image alone for the fast upscale and remove background', () => {
    for (const tool of ['upscale-fast', 'remove-background'] as const) {
      expect(stabilityToolBody(tool, toolRequest(tool, { prompt: 'ignored' }))).toEqual({
        image: base64(png),
        output_format: 'png',
      });
    }
  });

  it('always sends a prompt for the conservative and creative upscales, empty when none was written', () => {
    expect(stabilityToolBody('upscale-conservative', toolRequest('upscale-conservative'))).toEqual({
      image: base64(png),
      output_format: 'png',
      prompt: '',
    });
    expect(
      stabilityToolBody(
        'upscale-creative',
        toolRequest('upscale-creative', { prompt: '  A red fox  ' }),
      ),
    ).toEqual({ image: base64(png), output_format: 'png', prompt: 'A red fox' });
  });

  it('sends an erase with its mask as base64 and the mask growth', () => {
    const mask = new Uint8Array([1, 2, 3]);
    expect(stabilityToolBody('erase', toolRequest('erase', { mask, growMask: 7 }))).toEqual({
      image: base64(png),
      output_format: 'png',
      mask: base64(mask),
      grow_mask: 7,
    });
    expect(() => stabilityToolBody('erase', toolRequest('erase'))).toThrow(ProviderError);
  });

  it('sends every outpaint side, and the prompt only when there is one', () => {
    const outpaint = { left: 0, right: 256, up: 64, down: 0 };
    expect(stabilityToolBody('outpaint', toolRequest('outpaint', { outpaint }))).toEqual({
      image: base64(png),
      output_format: 'png',
      left: 0,
      right: 256,
      up: 64,
      down: 0,
    });
    expect(
      stabilityToolBody('outpaint', toolRequest('outpaint', { outpaint, prompt: 'more sea' })),
    ).toMatchObject({ prompt: 'more sea' });
    expect(() =>
      stabilityToolBody(
        'outpaint',
        toolRequest('outpaint', { outpaint: { left: 0, right: 0, up: 0, down: 0 } }),
      ),
    ).toThrow(ProviderError);
  });
});

describe('BedrockProvider.tool', () => {
  it.each(Object.entries(MODELS))(
    'invokes %s through its us. inference profile, at its list price',
    async (tool, id) => {
      bedrock
        .on(InvokeModelCommand)
        .resolves(response({ images: [base64(png)], seeds: [1], finish_reasons: [null] }));
      const model = seedModel(id);
      const result = await provider.tool(
        model,
        toolRequest(tool as ToolId, {
          mask: png,
          outpaint: { left: 10, right: 0, up: 0, down: 0 },
        }),
      );
      const [call] = bedrock.commandCalls(InvokeModelCommand);
      expect(call?.args[0].input).toMatchObject({
        modelId: `us.${model.providerModelId}`,
        contentType: 'application/json',
        accept: 'application/json',
      });
      expect(result.images).toEqual([{ png, width: 64, height: 48, seed: 1 }]);
      expect(result.providerCostCents).toBe(model.tools?.[tool as ToolId]?.costPoints);
      expect(result.providerRequestId).toBe('req-tool');
    },
  );

  it('keeps the transparency of a removed background', async () => {
    bedrock.on(InvokeModelCommand).resolves(response({ images: [base64(transparent)] }));
    const result = await provider.tool(
      seedModel('stable-image-remove-background'),
      toolRequest('remove-background'),
    );
    const image = result.images[0];
    expect(image?.png).toEqual(transparent);
    const meta = await sharp(image!.png).metadata();
    expect(meta.hasAlpha).toBe(true);
  });

  it('refuses a tool the model does not run, before any call', async () => {
    await expect(
      provider.tool(seedModel('stable-fast-upscale'), toolRequest('erase', { mask: png })),
    ).rejects.toThrow(/does not run erase/);
    expect(bedrock.commandCalls(InvokeModelCommand)).toHaveLength(0);
  });

  it('blocks on a content filter finish reason', async () => {
    bedrock
      .on(InvokeModelCommand)
      .resolves(response({ images: [''], finish_reasons: ['Filter reason: input image'] }));
    await expect(
      provider.tool(
        seedModel('stable-outpaint'),
        toolRequest('outpaint', {
          outpaint: { left: 10, right: 0, up: 0, down: 0 },
        }),
      ),
    ).rejects.toBeInstanceOf(ProviderSafetyError);
  });

  it('fails, without blocking, on an inference error', async () => {
    bedrock
      .on(InvokeModelCommand)
      .resolves(response({ images: [''], finish_reasons: ['Inference error'] }));
    const error = await provider
      .tool(seedModel('stable-fast-upscale'), toolRequest('upscale-fast'))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).not.toBeInstanceOf(ProviderSafetyError);
  });

  it('maps a validation error to a ProviderError that is not retried', async () => {
    bedrock
      .on(InvokeModelCommand)
      .rejects(new ValidationException({ message: 'image too large', $metadata: {} }));
    const error = await provider
      .tool(seedModel('stable-fast-upscale'), toolRequest('upscale-fast'))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).retryable).toBe(false);
  });

  it('is retried once on throttling through the provider factory', async () => {
    bedrock
      .on(InvokeModelCommand)
      .rejectsOnce(new ThrottlingException({ message: 'slow down', $metadata: {} }))
      .resolves(response({ images: [base64(png)] }));
    const providerFor = createProviderFactory({
      adapters: { bedrock: () => provider },
      retry: { delayMs: 1, jitterMs: 0 },
    });
    const model = seedModel('stable-fast-upscale');
    const result = await providerFor(model).tool!(model, toolRequest('upscale-fast'));
    expect(result.images).toHaveLength(1);
    expect(bedrock.commandCalls(InvokeModelCommand)).toHaveLength(2);
  });
});

describe('createProviderFactory and tools', () => {
  it('fails a tool on an adapter that runs none with a typed error', async () => {
    const providerFor = createProviderFactory({
      adapters: {
        openai: () => ({
          generate: () => Promise.reject(new Error('unused')),
          edit: () => Promise.reject(new Error('unused')),
        }),
      },
    });
    const model = seedModel('gpt-image-2');
    await expect(providerFor(model).tool!(model, toolRequest('upscale-fast'))).rejects.toThrow(
      ProviderError,
    );
  });
});

describe('prepareToolImage', () => {
  it('passes an image within the limits through unchanged', async () => {
    const input = await solidImage('png', 96, 64);
    expect(await prepareToolImage('erase', input)).toEqual({ png: input, width: 96, height: 64 });
  });

  it('scales an image down to the creative upscaler’s one megapixel', async () => {
    const big = await solidImage('png', 2048, 1024);
    const prepared = await prepareToolImage('upscale-creative', big);
    expect(prepared.width * prepared.height).toBeLessThanOrEqual(1_048_576);
    expect(prepared.width / prepared.height).toBeCloseTo(2, 1);
  });

  it('refuses an image the tool cannot take', async () => {
    await expect(
      prepareToolImage('remove-background', await solidImage('png', 40, 40)),
    ).rejects.toBeInstanceOf(ToolInputError);
  });
});

describe('prepareMask', () => {
  it('encodes the drawing as a black and white PNG at the image size, white where it was drawn', async () => {
    // A drawing at half size: a soft grey stroke on the left half, transparent on the right.
    const drawing = await sharp({
      create: { width: 32, height: 24, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: await sharp({
            create: {
              width: 16,
              height: 24,
              channels: 4,
              background: { r: 200, g: 200, b: 200, alpha: 1 },
            },
          })
            .png()
            .toBuffer(),
          left: 0,
          top: 0,
        },
      ])
      .png()
      .toBuffer();
    const mask = await prepareMask(new Uint8Array(drawing), { width: 64, height: 48 });

    const { data, info } = await sharp(mask).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([64, 48]);
    const values = new Set(data);
    expect([...values].sort((a, b) => a - b)).toEqual([0, 255]);
    const at = (x: number, y: number) => data[(y * info.width + x) * info.channels];
    expect(at(4, 24)).toBe(255);
    expect(at(60, 24)).toBe(0);
  });
});
