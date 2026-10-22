// @vitest-environment jsdom
import { loadSeedRegistry } from '@pictora/core';
import { createRegistryLoader } from '@pictora/core/registry-store';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageDetailBody } from '../src/lib/images';
import { SESSION_HEADERS } from '../src/lib/session';

const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
const onboarded = vi.hoisted(() => ({ current: true }));
const detail = vi.hoisted(() => ({
  current: undefined as { status: number; body: Record<string, unknown> } | undefined,
}));
const push = vi.hoisted(() => vi.fn());

vi.mock('next/headers', () => ({ headers: async () => requestHeaders.current }));

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect to ${url}`);
  }
}

class NotFoundSignal extends Error {}

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
  notFound: () => {
    throw new NotFoundSignal('not found');
  },
  useRouter: () => ({ push }),
}));

vi.mock('../src/lib/onboarding', () => ({
  requireOnboarding: async () => {
    if (!onboarded.current) throw new RedirectSignal('/onboarding');
  },
}));

vi.mock('../src/lib/registry', () => ({
  registryLoader: () =>
    createRegistryLoader({ source: async () => loadSeedRegistry(), environment: 'dev' }),
}));

vi.mock('../src/lib/images_deps', () => ({ imagesDeps: () => ({}) }));
vi.mock('../src/lib/images', () => ({ getImageDetail: async () => detail.current }));

const { default: GalleryPage } = await import('../src/app/gallery/page');
const { default: GalleryImagePage } = await import('../src/app/gallery/[imageId]/page');

const IMAGE_ID = '01JAAAAAAAAAAAAAAAAAAAAAAA';

function body(): ImageDetailBody {
  return {
    image: { imageId: IMAGE_ID, title: 'A fox', latestVersion: 1, versionCount: 1 },
    versions: [
      {
        version: 1,
        prompt: 'A fox',
        modelId: 'gemini-3.1-flash-image',
        width: 64,
        height: 64,
        url: 'https://signed.example/v1.png',
        downloadUrl: 'https://signed.example/v1.png?download',
        thumbUrl: 'https://signed.example/v1.webp',
      },
    ],
  };
}

const imagePage = () => GalleryImagePage({ params: Promise.resolve({ imageId: IMAGE_ID }) });

describe('gallery pages', () => {
  beforeEach(() => {
    requestHeaders.current = new Headers({
      [SESSION_HEADERS.sub]: 'user-sub',
      [SESSION_HEADERS.email]: 'user@example.com',
    });
    onboarded.current = true;
    detail.current = { status: 200, body: { ...body() } };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ images: [], jobs: [] })),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    push.mockReset();
  });

  it('shows the gallery grid', async () => {
    render(await GalleryPage());
    expect(screen.getByRole('heading', { level: 1, name: 'Your images' })).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'Create your first image' })).toBeTruthy();
  });

  it('shows an image as its own page, naming its model, and returns to the gallery after a delete', async () => {
    render(await imagePage());
    expect(screen.getByRole('heading', { level: 1, name: 'A fox' })).toBeTruthy();
    expect(screen.getByText('Gemini 3.1 Flash Image')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to your images' }).getAttribute('href')).toBe(
      '/gallery',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete image' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/gallery'));
  });

  it("is a 404 for an image that isn't the user's", async () => {
    detail.current = { status: 404, body: { code: 'not_found' } };
    await expect(imagePage()).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it('sends signed-out visitors home and new users to onboarding', async () => {
    onboarded.current = false;
    await expect(GalleryPage()).rejects.toMatchObject({ url: '/onboarding' });
    await expect(imagePage()).rejects.toMatchObject({ url: '/onboarding' });
    requestHeaders.current = new Headers();
    await expect(GalleryPage()).rejects.toMatchObject({ url: '/' });
    await expect(imagePage()).rejects.toMatchObject({ url: '/' });
  });
});
