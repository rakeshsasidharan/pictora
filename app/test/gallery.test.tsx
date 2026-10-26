// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Gallery } from '../src/components/gallery';
import type {
  ActiveJobBody,
  GalleryImageBody,
  GalleryPageBody,
  ImageDetailBody,
} from '../src/lib/images';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const MODEL_NAMES = { mock: 'Mock (dev only)' };

/** A ULID-shaped image ID that sorts by `n`. */
const idOf = (n: number) => `01J${String(n).padStart(23, '0')}`;

function tile(n: number, fields: Partial<GalleryImageBody> = {}): GalleryImageBody {
  return {
    imageId: idOf(n),
    title: `Image ${n}`,
    latestVersion: 1,
    versionCount: 1,
    thumbUrl: `https://signed.example/${n}_thumb.webp`,
    ...fields,
  };
}

const RUNNING: ActiveJobBody = {
  jobId: '01JQ0000000000000000000001',
  type: 'generate',
  status: 'running',
  createdAt: '2026-10-15T12:00:00.000Z',
  text: 'Two cats on a sofa',
  count: 2,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A fetch stand-in: each URL answers the next response queued for it, repeating the last one. */
function stubFetch(routes: Record<string, (Response | (() => Response))[]>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = init?.method && init.method !== 'GET' ? `${init.method} ${url}` : url;
    const queue = routes[key];
    if (!queue || queue.length === 0) throw new Error(`Unexpected fetch ${key}`);
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return typeof next === 'function' ? next() : next.clone();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function page(body: GalleryPageBody): Response {
  return json(body);
}

function setWideScreen(wide: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: wide })),
  );
  window.matchMedia = globalThis.matchMedia;
}

describe('Gallery', () => {
  beforeEach(() => setWideScreen(false));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('shows a loading state, then the images newest first linking to their pages', async () => {
    stubFetch({
      '/api/images': [page({ images: [tile(3, { versionCount: 2 }), tile(2)], jobs: [] })],
    });
    render(<Gallery modelNames={MODEL_NAMES} />);
    expect(screen.getByRole('status').textContent).toBe('Loading your images…');

    const grid = await screen.findByRole('list', { name: 'Your images' });
    const links = within(grid).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      `/gallery/${idOf(3)}`,
      `/gallery/${idOf(2)}`,
    ]);
    const image = within(links[0]!).getByRole('img');
    expect(image.getAttribute('alt')).toBe('Image 3');
    expect(image.getAttribute('src')).toBe('https://signed.example/3_thumb.webp');
    expect(within(links[0]!).getByText('2 versions')).toBeTruthy();
  });

  it('shows the empty state with a call to action', async () => {
    stubFetch({ '/api/images': [page({ images: [], jobs: [] })] });
    render(<Gallery modelNames={MODEL_NAMES} />);
    const create = await screen.findByRole('link', { name: 'Create your first image' });
    expect(create.getAttribute('href')).toBe('/generate');
    expect(screen.getByText(/Your gallery is empty/)).toBeTruthy();
  });

  it('shows an error with a way to try again', async () => {
    const fetchMock = stubFetch({
      '/api/images': [json({ error: 'nope' }, 500), page({ images: [tile(1)], jobs: [] })],
    });
    render(<Gallery modelNames={MODEL_NAMES} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("We couldn't load your gallery.");
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('img', { name: 'Image 1' })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('loads the next page with the cursor', async () => {
    stubFetch({
      '/api/images': [page({ images: [tile(30), tile(29)], nextCursor: idOf(29), jobs: [] })],
      [`/api/images?cursor=${idOf(29)}`]: [page({ images: [tile(28)] })],
    });
    render(<Gallery modelNames={MODEL_NAMES} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('img', { name: 'Image 28' })).toBeTruthy();
    expect(screen.getAllByRole('img').map((image) => image.getAttribute('alt'))).toEqual([
      'Image 30',
      'Image 29',
      'Image 28',
    ]);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('loads the next page when the end of the grid scrolls into view', async () => {
    let callback: IntersectionObserverCallback | undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(next: IntersectionObserverCallback) {
          callback = next;
        }
        observe() {}
        disconnect() {}
      },
    );
    const fetchMock = stubFetch({
      '/api/images': [page({ images: [tile(30)], nextCursor: idOf(30), jobs: [] })],
      [`/api/images?cursor=${idOf(30)}`]: [page({ images: [tile(29)] })],
    });
    render(<Gallery modelNames={MODEL_NAMES} />);
    await screen.findByRole('img', { name: 'Image 30' });
    await waitFor(() => expect(callback).toBeDefined());
    callback!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(await screen.findByRole('img', { name: 'Image 29' })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(`/api/images?cursor=${idOf(30)}`, expect.anything());
  });

  it('shows running jobs as placeholders at the top, then their images once they finish', async () => {
    stubFetch({
      '/api/images': [
        page({ images: [tile(1)], jobs: [RUNNING] }),
        page({ images: [tile(3), tile(2), tile(1)], jobs: [] }),
      ],
      [`/api/jobs/${RUNNING.jobId}`]: [
        json({ jobId: RUNNING.jobId, status: 'running' }),
        json({ jobId: RUNNING.jobId, status: 'succeeded' }),
      ],
    });
    render(<Gallery modelNames={MODEL_NAMES} pollIntervalMs={5} />);
    const grid = await screen.findByRole('list', { name: 'Your images' });
    const first = within(grid).getAllByRole('listitem')[0]!;
    expect(within(first).getByRole('status').textContent).toBe('Generating · 2 images');
    expect(first.textContent).toContain('Two cats on a sofa');

    await screen.findByRole('img', { name: 'Image 3' });
    expect(screen.queryByText('Two cats on a sofa')).toBeNull();
    expect(screen.getAllByRole('img').map((image) => image.getAttribute('alt'))).toEqual([
      'Image 3',
      'Image 2',
      'Image 1',
    ]);
  });

  it('shows batch jobs as Scheduled, and checks them at the slower batch pace', async () => {
    const scheduled: ActiveJobBody = {
      ...RUNNING,
      jobId: '01JQ0000000000000000000009',
      status: 'scheduled',
      text: 'A castle at dawn',
      count: 1,
      delivery: 'batch',
    };
    const fetchMock = stubFetch({
      '/api/images': [
        page({ images: [tile(1)], jobs: [scheduled] }),
        page({ images: [tile(2), tile(1)], jobs: [] }),
      ],
      [`/api/jobs/${scheduled.jobId}`]: [
        json({ jobId: scheduled.jobId, status: 'submitted' }),
        json({ jobId: scheduled.jobId, status: 'succeeded' }),
      ],
    });
    render(<Gallery modelNames={MODEL_NAMES} pollIntervalMs={5} batchPollIntervalMs={200} />);
    const grid = await screen.findByRole('list', { name: 'Your images' });
    const first = within(grid).getAllByRole('listitem')[0]!;
    expect(within(first).getByRole('status').textContent).toBe('Scheduled · 1 image');
    expect(first.textContent).toContain('A castle at dawn');

    // At the 5 ms pace a running job would have been checked many times by now.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/jobs/'))).toHaveLength(0);
    await screen.findByRole('img', { name: 'Image 2' }, { timeout: 2_000 });
    expect(screen.queryByText('A castle at dawn')).toBeNull();
  });

  it('fetches fresh URLs when a thumbnail fails to load after they may have expired', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    const fetchMock = stubFetch({
      '/api/images': [page({ images: [tile(3), tile(2)], nextCursor: idOf(2), jobs: [] })],
      [`/api/images?cursor=${idOf(3)}`]: [
        page({ images: [tile(2, { thumbUrl: 'https://signed.example/2_fresh.webp' })] }),
      ],
    });
    render(<Gallery modelNames={MODEL_NAMES} />);
    const image = await screen.findByRole('img', { name: 'Image 2' });

    // Just fetched: a failed load is some other problem, so nothing is fetched again.
    fireEvent.error(image);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000_000 + 16 * 60_000);
    fireEvent.error(image);
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'Image 2' }).getAttribute('src')).toBe(
        'https://signed.example/2_fresh.webp',
      ),
    );
    now.mockRestore();
  });

  it('opens the detail as a modal on wide screens and removes a deleted image', async () => {
    setWideScreen(true);
    const detail: ImageDetailBody = {
      image: { imageId: idOf(2), title: 'Image 2', latestVersion: 1, versionCount: 1 },
      versions: [
        {
          version: 1,
          prompt: 'Image 2',
          modelId: 'mock',
          width: 1024,
          height: 1024,
          url: 'https://signed.example/2.png',
          downloadUrl: 'https://signed.example/2.png?download',
          thumbUrl: 'https://signed.example/2_thumb.webp',
        },
      ],
    };
    stubFetch({
      '/api/images': [page({ images: [tile(3), tile(2)], jobs: [] })],
      [`/api/images/${idOf(2)}`]: [json(detail)],
      [`DELETE /api/images/${idOf(2)}`]: [json({ imageId: idOf(2), deleted: true })],
    });
    render(<Gallery modelNames={MODEL_NAMES} />);
    fireEvent.click(await screen.findByRole('img', { name: 'Image 2' }));

    const dialog = await screen.findByRole('dialog', { name: 'Image details' });
    expect(await within(dialog).findByRole('heading', { name: 'Image 2' })).toBeTruthy();
    expect(within(dialog).getByText('Mock (dev only)')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    // The confirmation opens over the modal.
    const confirm = screen.getByRole('alertdialog', { name: 'Delete this image?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete image' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('img', { name: 'Image 2' })).toBeNull();
    expect(screen.getByRole('img', { name: 'Image 3' })).toBeTruthy();
  });

  it('closes the modal with its Close button and with Escape', async () => {
    setWideScreen(true);
    stubFetch({
      '/api/images': [page({ images: [tile(2)], jobs: [] })],
      [`/api/images/${idOf(2)}`]: [json({ error: 'nope' }, 500)],
    });
    render(<Gallery modelNames={MODEL_NAMES} />);
    fireEvent.click(await screen.findByRole('img', { name: 'Image 2' }));
    const dialog = await screen.findByRole('dialog', { name: 'Image details' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('img', { name: 'Image 2' }));
    fireEvent.keyDown(await screen.findByRole('dialog', { name: 'Image details' }), {
      key: 'Escape',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('follows the link to the detail page on narrow screens', async () => {
    stubFetch({ '/api/images': [page({ images: [tile(2)], jobs: [] })] });
    render(<Gallery modelNames={MODEL_NAMES} />);
    const link = (await screen.findByRole('img', { name: 'Image 2' })).closest('a')!;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
