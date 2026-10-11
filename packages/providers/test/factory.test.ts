import { describe, expect, it, vi } from 'vitest';
import { ProviderError, ProviderRateLimitError, ProviderTimeoutError } from '../src/errors.js';
import { createProviderFactory } from '../src/factory.js';
import { normalisePng, thumbnail } from '../src/image.js';
import { MockProvider } from '../src/mock.js';
import { providerSignal } from '../src/retry.js';
import type { ImageProvider } from '../src/types.js';
import { httpError, request, seedModel } from './helpers.js';

const fast = { delayMs: 1, jitterMs: 0 };

function stubAdapter(generate: ImageProvider['generate']): ImageProvider {
  return { generate, edit: generate };
}

describe('createProviderFactory', () => {
  it('picks the mock adapter for the mock model by default', async () => {
    process.env.MOCK_PROVIDER_DELAY_MS = '0';
    try {
      const providerFor = createProviderFactory();
      const result = await providerFor(seedModel('mock')).generate(seedModel('mock'), request());
      expect(result.images).toHaveLength(1);
    } finally {
      delete process.env.MOCK_PROVIDER_DELAY_MS;
    }
  });

  it('picks the adapter from ModelConfig.provider and builds it once', () => {
    const openai = vi.fn(() => stubAdapter(vi.fn()));
    const gemini = vi.fn(() => stubAdapter(vi.fn()));
    const providerFor = createProviderFactory({ adapters: { openai, gemini } });

    const first = providerFor(seedModel('gpt-image-2'));
    const second = providerFor(seedModel('gpt-image-1-mini'));
    providerFor(seedModel('gemini-3.1-flash-image'));

    expect(first).toBe(second);
    expect(openai).toHaveBeenCalledTimes(1);
    expect(gemini).toHaveBeenCalledTimes(1);
  });

  it('throws a typed error for a provider without an adapter', () => {
    const providerFor = createProviderFactory({ adapters: {} });
    expect(() => providerFor(seedModel('gpt-image-2'))).toThrow(ProviderError);
  });

  it('retries a wrapped adapter once on a rate limit', async () => {
    const generate = vi
      .fn()
      .mockRejectedValueOnce(httpError(429))
      .mockResolvedValue({ images: [], providerCostCents: 0 });
    const providerFor = createProviderFactory({
      adapters: { openai: () => stubAdapter(generate) },
      retry: fast,
    });
    const model = seedModel('gpt-image-2');
    await expect(providerFor(model).generate(model, request())).resolves.toEqual({
      images: [],
      providerCostCents: 0,
    });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it.each([
    [httpError(429), ProviderRateLimitError],
    [new DOMException('aborted', 'AbortError'), ProviderTimeoutError],
    [new Error('anything'), ProviderError],
    ['not even an error', ProviderError],
  ])('maps whatever an adapter throws (%s) to a typed error', async (thrown, errorClass) => {
    const providerFor = createProviderFactory({
      adapters: { openai: () => stubAdapter(() => Promise.reject(thrown)) },
      retry: fast,
    });
    const model = seedModel('gpt-image-2');
    await expect(providerFor(model).edit(model, request())).rejects.toBeInstanceOf(errorClass);
  });

  it('wraps the mock too, so its errors are typed', async () => {
    const providerFor = createProviderFactory({
      adapters: { mock: () => new MockProvider({ delayMs: 0 }) },
      retry: fast,
    });
    const model = seedModel('mock');
    await expect(
      providerFor(model).generate(model, request({ prompt: '__timeout__' })),
    ).rejects.toBeInstanceOf(ProviderTimeoutError);
  });
});

describe('a full job against the mock provider', () => {
  it('runs with no network access: generate, normalise and thumbnail', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network disabled'));
    try {
      const model = seedModel('mock');
      const providerFor = createProviderFactory({
        adapters: { mock: () => new MockProvider({ delayMs: 0 }) },
      });
      const result = await providerFor(model).generate(
        model,
        request({ aspect: '16:9', quality: 'standard', count: 2, signal: providerSignal() }),
      );

      for (const image of result.images) {
        const stored = await normalisePng(image.png);
        const thumb = await thumbnail(stored.png);
        expect(stored).toMatchObject({ width: 1376, height: 768 });
        expect(thumb).toMatchObject({ width: 512, height: 286 });
      }
      expect(result.images).toHaveLength(2);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
