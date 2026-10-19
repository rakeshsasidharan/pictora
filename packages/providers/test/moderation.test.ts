import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProviderError, ProviderRateLimitError, ProviderTimeoutError } from '../src/errors.js';
import {
  MODERATION_MODEL,
  OPENAI_MODERATION_URL,
  createModerator,
  imageDataUrl,
  parseModeration,
} from '../src/moderation.js';
import { solidImage } from './helpers.js';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const retry = { delayMs: 0, jitterMs: 0 };

function moderator(apiKey = async () => 'sk-test') {
  return createModerator({ apiKey, retry, timeoutMs: 2_000 });
}

function result(flagged: boolean, categories: Record<string, boolean> = {}) {
  return { id: 'modr-1', model: 'omni-moderation-latest', results: [{ flagged, categories }] };
}

describe('createModerator', () => {
  it('sends the text and image to omni-moderation-latest with the key, and returns the verdict', async () => {
    let seen: { auth: string | null; body: unknown } | undefined;
    server.use(
      http.post(OPENAI_MODERATION_URL, async ({ request }) => {
        seen = { auth: request.headers.get('authorization'), body: await request.json() };
        return HttpResponse.json(result(true, { sexual: true, violence: false }));
      }),
    );
    const png = await solidImage('png', 4, 4);
    const verdict = await moderator()({ text: '  a prompt  ', image: png });
    expect(verdict).toEqual({ flagged: true, categories: { sexual: true, violence: false } });
    expect(seen?.auth).toBe('Bearer sk-test');
    expect(seen?.body).toEqual({
      model: MODERATION_MODEL,
      input: [
        { type: 'text', text: 'a prompt' },
        { type: 'image_url', image_url: { url: imageDataUrl(png) } },
      ],
    });
  });

  it('returns an unflagged answer as is', async () => {
    server.use(http.post(OPENAI_MODERATION_URL, () => HttpResponse.json(result(false))));
    expect(await moderator()({ text: 'a lighthouse at dusk' })).toEqual({
      flagged: false,
      categories: {},
    });
  });

  it('retries a 500 once', async () => {
    const calls = vi.fn();
    server.use(
      http.post(OPENAI_MODERATION_URL, () => {
        calls();
        return calls.mock.calls.length === 1
          ? new HttpResponse(null, { status: 500 })
          : HttpResponse.json(result(false));
      }),
    );
    expect((await moderator()({ text: 'hello' })).flagged).toBe(false);
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('throws when the endpoint keeps failing, so callers fail safe', async () => {
    server.use(http.post(OPENAI_MODERATION_URL, () => new HttpResponse(null, { status: 503 })));
    await expect(moderator()({ text: 'hello' })).rejects.toBeInstanceOf(ProviderError);
    server.use(http.post(OPENAI_MODERATION_URL, () => new HttpResponse(null, { status: 429 })));
    await expect(moderator()({ text: 'hello' })).rejects.toBeInstanceOf(ProviderRateLimitError);
    server.use(http.post(OPENAI_MODERATION_URL, () => new HttpResponse(null, { status: 401 })));
    await expect(moderator()({ text: 'hello' })).rejects.toMatchObject({ status: 401 });
    server.use(http.post(OPENAI_MODERATION_URL, () => HttpResponse.error()));
    await expect(moderator()({ text: 'hello' })).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws on an answer without results', async () => {
    server.use(http.post(OPENAI_MODERATION_URL, () => HttpResponse.json({ results: [] })));
    await expect(moderator()({ text: 'hello' })).rejects.toThrow(/no results/);
  });

  it('times out', async () => {
    server.use(
      http.post(OPENAI_MODERATION_URL, async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return HttpResponse.json(result(false));
      }),
    );
    const slow = createModerator({ apiKey: async () => 'k', retry, timeoutMs: 50 });
    await expect(slow({ text: 'hello' })).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it('throws when the key cannot be read or there is nothing to check', async () => {
    const noKey = moderator(async () => {
      throw new Error('AccessDenied');
    });
    await expect(noKey({ text: 'hello' })).rejects.toThrow(/API key could not be read/);
    await expect(moderator()({ text: '   ' })).rejects.toThrow(/Nothing to moderate/);
  });
});

describe('parseModeration', () => {
  it('combines several results', () => {
    expect(
      parseModeration({
        results: [
          { flagged: false, categories: { sexual: false, hate: false } },
          { flagged: true, categories: { sexual: true, hate: false } },
        ],
      }),
    ).toEqual({ flagged: true, categories: { sexual: true, hate: false } });
  });
});

describe('imageDataUrl', () => {
  it('reads the type from the file signature', async () => {
    expect(imageDataUrl(await solidImage('png', 2, 2))).toMatch(/^data:image\/png;base64,/);
    expect(imageDataUrl(await solidImage('jpeg', 2, 2))).toMatch(/^data:image\/jpeg;base64,/);
    expect(imageDataUrl(await solidImage('webp', 2, 2))).toMatch(/^data:image\/webp;base64,/);
    expect(() => imageDataUrl(new Uint8Array([1, 2, 3, 4]))).toThrow(ProviderError);
  });
});
