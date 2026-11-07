import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { ProviderError, ProviderSafetyError, ProviderTimeoutError } from '../src/errors.js';
import { isPng } from '../src/image.js';
import { MockProvider } from '../src/mock.js';
import { request, seedModel, solidImage } from './helpers.js';

const mock = seedModel('mock');
const provider = new MockProvider({ delayMs: 0 });

describe('MockProvider', () => {
  it.each([
    ['1:1', 1024, 1024],
    ['16:9', 1376, 768],
    ['9:16', 768, 1376],
    ['4:5', 928, 1152],
  ] as const)('generates a %s PNG at the mapped size', async (aspect, width, height) => {
    const result = await provider.generate(mock, request({ aspect }));
    expect(result.images).toHaveLength(1);
    const [image] = result.images;
    expect(image).toMatchObject({ width, height });
    expect(isPng(image!.png)).toBe(true);
    expect(await sharp(image!.png).metadata()).toMatchObject({ format: 'png', width, height });
  });

  it('returns as many images as asked, with distinct seeds', async () => {
    const result = await provider.generate(mock, request({ count: 3, seed: 7 }));
    expect(result.images.map((image) => image.seed)).toEqual([7, 8, 9]);
  });

  it('charges the model list price per image', async () => {
    const result = await provider.generate(mock, request({ quality: 'high', count: 2 }));
    expect(result.providerCostCents).toBe(mock.qualities.high!.costPoints * 2);
    expect(result.providerRequestId).toMatch(/^mock-/);
  });

  it('edits an input image', async () => {
    const inputImage = await solidImage('png', 500, 500);
    const result = await provider.edit(mock, request({ prompt: 'make it blue', inputImage }));
    expect(result.images[0]).toMatchObject({ width: 1024, height: 1024 });
    expect(isPng(result.images[0]!.png)).toBe(true);
  });

  it('rejects an edit without an input image', async () => {
    await expect(provider.edit(mock, request())).rejects.toBeInstanceOf(ProviderError);
  });

  it.each([
    ['__fail__', ProviderError],
    ['__block__', ProviderSafetyError],
    ['__timeout__', ProviderTimeoutError],
  ])('raises the matching error for %s, for generate and edit', async (keyword, errorClass) => {
    const prompt = `a cat ${keyword} on a mat`;
    await expect(provider.generate(mock, request({ prompt }))).rejects.toBeInstanceOf(errorClass);
    const inputImage = await solidImage('png', 64, 64);
    await expect(provider.edit(mock, request({ prompt, inputImage }))).rejects.toBeInstanceOf(
      errorClass,
    );
  });

  it('raises a plain, non-retryable provider error for __fail__', async () => {
    const error = await provider.generate(mock, request({ prompt: '__fail__' })).catch((e) => e);
    expect(error.constructor).toBe(ProviderError);
    expect(error.retryable).toBe(false);
  });

  it('waits the configured delay, and stops early when aborted', async () => {
    const slow = new MockProvider({ delayMs: 10_000 });
    const controller = new AbortController();
    const started = Date.now();
    const result = slow.generate(mock, request({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 10);
    await expect(result).rejects.toBeInstanceOf(ProviderTimeoutError);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('takes the delay from MOCK_PROVIDER_DELAY_MS', () => {
    process.env.MOCK_PROVIDER_DELAY_MS = '250';
    try {
      expect(new MockProvider().delayMs).toBe(250);
    } finally {
      delete process.env.MOCK_PROVIDER_DELAY_MS;
    }
  });

  it('escapes prompt text safely in the placeholder', async () => {
    const result = await provider.generate(mock, request({ prompt: '<svg> & "quotes" </text>' }));
    expect(isPng(result.images[0]!.png)).toBe(true);
  });
});

describe('MockProvider.tool', () => {
  const signal = new AbortController().signal;

  it('upscales by doubling each side, at the tool price', async () => {
    const image = await solidImage('png', 300, 200);
    const result = await provider.tool(mock, { tool: 'upscale-fast', image, signal });
    expect(result.images[0]).toMatchObject({ width: 600, height: 400 });
    expect(result.providerCostCents).toBe(mock.tools?.['upscale-fast']?.costPoints);
  });

  it('removes the background into a PNG with transparency', async () => {
    const image = await solidImage('png', 200, 200);
    const result = await provider.tool(mock, { tool: 'remove-background', image, signal });
    const { data, info } = await sharp(result.images[0]!.png)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    expect(data[3]).toBe(0);
    const centre = (100 * 200 + 100) * 4;
    expect(data[centre + 3]).toBe(255);
  });

  it('extends the canvas for an outpaint', async () => {
    const image = await solidImage('png', 200, 100);
    const result = await provider.tool(mock, {
      tool: 'outpaint',
      image,
      outpaint: { left: 50, right: 0, up: 0, down: 25 },
      signal,
    });
    expect(result.images[0]).toMatchObject({ width: 250, height: 125 });
  });

  it('greys out the masked area for an erase, at the same size', async () => {
    const image = await solidImage('png', 100, 100);
    const mask = new Uint8Array(
      await sharp({ create: { width: 100, height: 100, channels: 3, background: '#ffffff' } })
        .png()
        .toBuffer(),
    );
    const result = await provider.tool(mock, { tool: 'erase', image, mask, signal });
    expect(result.images[0]).toMatchObject({ width: 100, height: 100 });
    const { data } = await sharp(result.images[0]!.png).raw().toBuffer({ resolveWithObject: true });
    expect([data[0], data[1], data[2]]).toEqual([128, 128, 128]);
    await expect(provider.tool(mock, { tool: 'erase', image, signal })).rejects.toThrow(
      ProviderError,
    );
  });

  it('raises the error a test prompt asks for', async () => {
    const image = await solidImage('png', 100, 100);
    await expect(
      provider.tool(mock, { tool: 'upscale-creative', image, prompt: 'x __block__', signal }),
    ).rejects.toBeInstanceOf(ProviderSafetyError);
    await expect(
      provider.tool(mock, { tool: 'upscale-creative', image, prompt: '__fail__', signal }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('refuses a tool on a model that runs none', async () => {
    const image = await solidImage('png', 100, 100);
    await expect(
      provider.tool(seedModel('gpt-image-2'), { tool: 'upscale-fast', image, signal }),
    ).rejects.toThrow(/does not run upscale-fast/);
  });
});
