import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_HEADERS } from '../src/lib/session';

const images = vi.hoisted(() => ({
  GALLERY_MAX_LIMIT: 50,
  listImages: vi.fn(),
  deleteImage: vi.fn(),
  getImageDetail: vi.fn(),
  versionDownloadUrl: vi.fn(),
  setVersionAltText: vi.fn(),
}));

vi.mock('../src/lib/images', () => images);
vi.mock('../src/lib/images_deps', () => ({ imagesDeps: () => ({ tableName: 'pictora-test' }) }));

const { GET: list } = await import('../src/app/api/images/route');
const { GET: detail, DELETE: remove } = await import('../src/app/api/images/[id]/route');
const { GET: download } = await import('../src/app/api/images/[id]/versions/[n]/download/route');
const { PATCH: setAltText } = await import('../src/app/api/images/[id]/versions/[n]/route');

const base = 'https://pictora.example.dev/api/images';
const IMAGE_ID = '01JAAAAAAAAAAAAAAAAAAAAAAA';
const signedIn = { [SESSION_HEADERS.sub]: 'user-sub', [SESSION_HEADERS.email]: 'u@example.com' };
const params = { params: Promise.resolve({ id: IMAGE_ID }) };
const versionParams = { params: Promise.resolve({ id: IMAGE_ID, n: '2' }) };

describe('image routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('answer 401 without a session', async () => {
    expect((await list(new NextRequest(base))).status).toBe(401);
    expect((await detail(new NextRequest(`${base}/${IMAGE_ID}`), params)).status).toBe(401);
    expect(
      (await remove(new NextRequest(`${base}/${IMAGE_ID}`, { method: 'DELETE' }), params)).status,
    ).toBe(401);
    expect(
      (await download(new NextRequest(`${base}/${IMAGE_ID}/versions/2/download`), versionParams))
        .status,
    ).toBe(401);
    expect(
      (
        await setAltText(
          new NextRequest(`${base}/${IMAGE_ID}/versions/2`, {
            method: 'PATCH',
            body: JSON.stringify({ altText: 'A fox' }),
          }),
          versionParams,
        )
      ).status,
    ).toBe(401);
    expect(images.listImages).not.toHaveBeenCalled();
    expect(images.setVersionAltText).not.toHaveBeenCalled();
  });

  it('GET /api/images passes the cursor and answers the page, uncached', async () => {
    images.listImages.mockResolvedValue({ status: 200, body: { images: [] } });
    const response = await list(
      new NextRequest(`${base}?cursor=${IMAGE_ID}`, { headers: signedIn }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ images: [] });
    expect(images.listImages).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sub: 'user-sub' }),
      IMAGE_ID,
      undefined,
    );
  });

  it('GET /api/images passes a limit from 1 to 50', async () => {
    images.listImages.mockResolvedValue({ status: 200, body: { images: [] } });
    for (const limit of [1, 10, 50]) {
      const response = await list(new NextRequest(`${base}?limit=${limit}`, { headers: signedIn }));
      expect(response.status).toBe(200);
      expect(images.listImages).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ sub: 'user-sub' }),
        null,
        limit,
      );
    }
  });

  it('GET /api/images rejects a limit outside 1 to 50, or not a whole number', async () => {
    for (const limit of ['0', '51', 'ten', '', '2.5', '-3', '1e1']) {
      const response = await list(
        new NextRequest(`${base}?limit=${encodeURIComponent(limit)}`, { headers: signedIn }),
      );
      expect(response.status, limit).toBe(400);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toMatchObject({ code: 'invalid_request' });
    }
    expect(images.listImages).not.toHaveBeenCalled();
  });

  it('DELETE /api/images/:id answers what the delete did', async () => {
    images.deleteImage.mockResolvedValue({ status: 404, body: { code: 'not_found' } });
    const response = await remove(
      new NextRequest(`${base}/${IMAGE_ID}`, { method: 'DELETE', headers: signedIn }),
      params,
    );
    expect(response.status).toBe(404);
    expect(images.deleteImage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sub: 'user-sub' }),
      IMAGE_ID,
    );
  });

  it('the download route redirects to the presigned PNG, or answers 404', async () => {
    images.versionDownloadUrl.mockResolvedValueOnce('https://signed.example/v2.png?download');
    const found = await download(
      new NextRequest(`${base}/${IMAGE_ID}/versions/2/download`, { headers: signedIn }),
      versionParams,
    );
    expect(found.status).toBe(302);
    expect(found.headers.get('Location')).toBe('https://signed.example/v2.png?download');
    expect(found.headers.get('Cache-Control')).toBe('no-store');
    expect(images.versionDownloadUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sub: 'user-sub' }),
      IMAGE_ID,
      '2',
    );

    images.versionDownloadUrl.mockResolvedValueOnce(undefined);
    const missing = await download(
      new NextRequest(`${base}/${IMAGE_ID}/versions/2/download`, { headers: signedIn }),
      versionParams,
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'not_found' });
  });

  it('PATCH /api/images/:id/versions/:n passes the body on and answers what the update did', async () => {
    images.setVersionAltText.mockResolvedValue({
      status: 200,
      body: { imageId: IMAGE_ID, version: 2, altText: 'A fox asleep' },
    });
    const response = await setAltText(
      new NextRequest(`${base}/${IMAGE_ID}/versions/2`, {
        method: 'PATCH',
        headers: signedIn,
        body: JSON.stringify({ altText: 'A fox asleep' }),
      }),
      versionParams,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      imageId: IMAGE_ID,
      version: 2,
      altText: 'A fox asleep',
    });
    expect(images.setVersionAltText).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sub: 'user-sub' }),
      IMAGE_ID,
      '2',
      { altText: 'A fox asleep' },
    );
  });

  it('PATCH /api/images/:id/versions/:n answers 400 for a body that is not JSON', async () => {
    const response = await setAltText(
      new NextRequest(`${base}/${IMAGE_ID}/versions/2`, {
        method: 'PATCH',
        headers: signedIn,
        body: 'not json',
      }),
      versionParams,
    );
    expect(response.status).toBe(400);
    expect(images.setVersionAltText).not.toHaveBeenCalled();
  });
});
