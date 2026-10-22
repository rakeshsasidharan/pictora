import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_HEADERS } from '../src/lib/session';

const images = vi.hoisted(() => ({
  listImages: vi.fn(),
  deleteImage: vi.fn(),
  getImageDetail: vi.fn(),
  versionDownloadUrl: vi.fn(),
}));

vi.mock('../src/lib/images', () => images);
vi.mock('../src/lib/images_deps', () => ({ imagesDeps: () => ({ tableName: 'pictora-test' }) }));

const { GET: list } = await import('../src/app/api/images/route');
const { GET: detail, DELETE: remove } = await import('../src/app/api/images/[id]/route');
const { GET: download } = await import('../src/app/api/images/[id]/versions/[n]/download/route');

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
    expect(images.listImages).not.toHaveBeenCalled();
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
    );
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
});
