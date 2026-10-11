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
