import { describe, expect, it, vi } from 'vitest';
import {
  MAX_CLEANUP_ROUNDS,
  deleteAllImages,
  isTesterAccount,
  type CleanupRequest,
} from '../src/cleanup.js';

/** A stand-in for an API response: just the parts the cleanup reads. */
function response(status: number, body: unknown = {}) {
  return { ok: () => status >= 200 && status < 300, status: () => status, json: async () => body };
}

/** A fake API with a gallery of `ids`, 2 to a page, that deletes from it like the real one. */
function fakeApi(ids: string[], options: { models?: string[]; deleteStatus?: number } = {}) {
  const gallery = [...ids];
  const deletes: { url: string; origin?: string }[] = [];
  const request = {
    get: vi.fn(async (url: string) => {
      if (url === '/api/models') {
        return response(200, { models: (options.models ?? []).map((id) => ({ id })) });
      }
      return response(200, { images: gallery.slice(0, 2).map((imageId) => ({ imageId })) });
    }),
    delete: vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      deletes.push({ url, origin: init?.headers?.origin });
      if (options.deleteStatus) return response(options.deleteStatus);
      const id = url.split('/').at(-1);
      gallery.splice(gallery.indexOf(id ?? ''), 1);
      return response(200);
    }),
  };
  return { request: request as unknown as CleanupRequest, deletes, gallery };
}

describe('isTesterAccount', () => {
  it('is true only when the account is offered the Mock model', async () => {
    expect(await isTesterAccount(fakeApi([], { models: ['gpt-image-2', 'mock'] }).request)).toBe(
      true,
    );
    expect(await isTesterAccount(fakeApi([], { models: ['gpt-image-2'] }).request)).toBe(false);
  });

  it('fails when the models API fails', async () => {
    const request = { get: async () => response(500) } as unknown as CleanupRequest;
    await expect(isTesterAccount(request)).rejects.toThrow('GET /api/models answered 500');
  });
});

describe('deleteAllImages', () => {
  it('deletes every image across pages, with the site origin, and reports how many', async () => {
    const api = fakeApi(['A', 'B', 'C', 'D', 'E']);
    expect(await deleteAllImages(api.request, 'https://dev.example')).toBe(5);
    expect(api.gallery).toEqual([]);
    expect(api.deletes.map((call) => call.url)).toEqual([
      '/api/images/A',
      '/api/images/B',
      '/api/images/C',
      '/api/images/D',
      '/api/images/E',
    ]);
    expect(api.deletes.every((call) => call.origin === 'https://dev.example')).toBe(true);
  });

  it('does nothing for an empty gallery', async () => {
    const api = fakeApi([]);
    expect(await deleteAllImages(api.request, 'https://dev.example')).toBe(0);
    expect(api.deletes).toEqual([]);
  });

  it('fails on a delete error other than not found', async () => {
    const api = fakeApi(['A'], { deleteStatus: 403 });
    await expect(deleteAllImages(api.request, 'https://dev.example')).rejects.toThrow(
      'DELETE /api/images/A answered 403',
    );
  });

  it('gives up when images keep coming back', async () => {
    // A 404 counts as deleted, but this gallery never empties.
    const api = fakeApi(['A'], { deleteStatus: 404 });
    await expect(deleteAllImages(api.request, 'https://dev.example')).rejects.toThrow(
      `after ${MAX_CLEANUP_ROUNDS} rounds`,
    );
  });
});
