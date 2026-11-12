// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollectionsDialog } from '../src/components/collections_dialog';
import { Gallery } from '../src/components/gallery';
import { ImageOrganiser } from '../src/components/image_organiser';
import type { CollectionBody, TagBody } from '../src/lib/collections';
import { bulkSummary, sendBulk, useOrganiseData } from '../src/lib/collections_client';
import {
  NO_FILTER,
  filterFromParams,
  galleryApiUrl,
  galleryUrl,
  isFiltered,
  isRanked,
} from '../src/lib/gallery_filter';
import type { GalleryImageBody, GalleryPageBody } from '../src/lib/images';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const MODEL_NAMES = { mock: 'Mock (dev only)' };

/** A ULID-shaped ID that sorts by `n`. */
const idOf = (n: number) => `01J${String(n).padStart(23, '0')}`;
const LOGOS = idOf(901);
const ICONS = idOf(902);

const COLLECTIONS: CollectionBody[] = [
  { collectionId: ICONS, name: 'Icons', imageCount: 0, createdAt: '2026-11-01T00:00:00.000Z' },
  { collectionId: LOGOS, name: 'Logos', imageCount: 2, createdAt: '2026-11-01T00:00:00.000Z' },
];
const TAGS: TagBody[] = [
  { tag: 'sunset', imageCount: 3 },
  { tag: 'beach', imageCount: 1 },
];

function tile(n: number, fields: Partial<GalleryImageBody> = {}): GalleryImageBody {
  return {
    imageId: idOf(n),
    title: `Image ${n}`,
    latestVersion: 1,
    versionCount: 1,
    thumbUrl: `https://signed.example/${n}_thumb.webp`,
    tags: [],
    ...fields,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A fetch stand-in: each URL (with its method, unless GET) answers the next queued response, repeating the last. */
function stubFetch(routes: Record<string, (Response | ((init?: RequestInit) => Response))[]>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = init?.method && init.method !== 'GET' ? `${init.method} ${url}` : url;
    const queue = routes[key];
    if (!queue || queue.length === 0) throw new Error(`Unexpected fetch ${key}`);
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return typeof next === 'function' ? next(init) : next.clone();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const ORGANISE_ROUTES = {
  '/api/collections': [json({ collections: COLLECTIONS })],
  '/api/tags': [json({ tags: TAGS })],
};

function page(body: GalleryPageBody): Response {
  return json(body);
}

/** The JSON bodies sent with a method and URL. */
function sent(fetchMock: ReturnType<typeof stubFetch>, method: string, url: string): unknown[] {
  return fetchMock.mock.calls
    .filter(([calledUrl, init]) => calledUrl === url && init?.method === method)
    .map(([, init]) => JSON.parse(String(init?.body)));
}

/** Every bulk change succeeds for each image sent. */
function bulkOk(init?: RequestInit): Response {
  const { imageIds } = JSON.parse(String(init?.body)) as { imageIds: string[] };
  return json({ results: imageIds.map((imageId) => ({ imageId, ok: true })) });
}

function openMenu(name: string) {
  fireEvent.keyDown(screen.getByRole('button', { name }), { key: 'Enter' });
  return screen.getByRole('menu');
}

function choose(combobox: string, option: string) {
  fireEvent.keyDown(screen.getByRole('combobox', { name: combobox }), { key: 'Enter' });
  fireEvent.click(screen.getByRole('option', { name: option }));
}

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false })),
  );
  window.history.replaceState(null, '', '/gallery');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('gallery search and filters', () => {
  it('searches as the user types, keeping the ranked order, the count and the address', async () => {
    stubFetch({
      '/api/images': [page({ images: [tile(5), tile(2)], jobs: [] })],
      '/api/images?q=fox': [page({ images: [tile(2), tile(5)], total: 2 })],
    });
    render(<Gallery modelNames={MODEL_NAMES} searchDebounceMs={0} />);
    await screen.findByRole('img', { name: 'Image 5' });

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search your images' }), {
      target: { value: 'fox' },
    });
    expect(await screen.findByText('2 images match')).toBeTruthy();
    // Best match first, not newest first.
    expect(screen.getAllByRole('img').map((image) => image.getAttribute('alt'))).toEqual([
      'Image 2',
      'Image 5',
    ]);
    expect(`${window.location.pathname}${window.location.search}`).toBe('/gallery?q=fox');

    fireEvent.click(screen.getByRole('button', { name: 'Show all images' }));
    await waitFor(() => expect(screen.queryByText('2 images match')).toBeNull());
    expect(window.location.search).toBe('');
    expect(
      (screen.getByRole('searchbox', { name: 'Search your images' }) as HTMLInputElement).value,
    ).toBe('');
  });

  it('opens on the filter in the address, naming the collection, and filters by tag too', async () => {
    const fetchMock = stubFetch({
      ...ORGANISE_ROUTES,
      [`/api/images?collection=${LOGOS}`]: [page({ images: [tile(3), tile(1)] })],
      [`/api/images?tag=sunset&collection=${LOGOS}`]: [page({ images: [tile(1)], total: 1 })],
    });
    render(
      <Gallery
        modelNames={MODEL_NAMES}
        initialFilter={{ ...NO_FILTER, collection: LOGOS }}
        searchDebounceMs={0}
      />,
    );
    await screen.findByRole('img', { name: 'Image 3' });
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Collection' }).textContent).toBe('Logos'),
    );
    expect(screen.getByText('Showing one collection')).toBeTruthy();

    choose('Tag', 'sunset');
    expect(await screen.findByText('1 image matches')).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Image 3' })).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(`/api/images?tag=sunset&collection=${LOGOS}`, {
      cache: 'no-store',
    });
    expect(window.location.search).toBe(`?tag=sunset&collection=${LOGOS}`);
  });

  it('says when nothing matches', async () => {
    stubFetch({ '/api/images?q=giraffe': [page({ images: [], total: 0 })] });
    render(<Gallery modelNames={MODEL_NAMES} initialFilter={{ ...NO_FILTER, q: 'giraffe' }} />);
    expect(await screen.findByText('No images match.')).toBeTruthy();
    expect(screen.getByText('0 images match')).toBeTruthy();
    expect(screen.queryByText(/Your gallery is empty/)).toBeNull();
  });

  it('makes no requests for collections or tags until a menu needs them', async () => {
    const fetchMock = stubFetch({
      ...ORGANISE_ROUTES,
      '/api/images': [page({ images: [tile(1)], jobs: [] })],
    });
    render(<Gallery modelNames={MODEL_NAMES} />);
    await screen.findByRole('img', { name: 'Image 1' });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/images']);

    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Collection' }), { key: 'Enter' });
    expect(await screen.findByRole('option', { name: 'Logos' })).toBeTruthy();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(
      expect.arrayContaining(['/api/collections', '/api/tags']),
    );
  });
});

describe('selecting images', () => {
  async function renderSelecting(routes: Parameters<typeof stubFetch>[0], filter = NO_FILTER) {
    const fetchMock = stubFetch({ ...ORGANISE_ROUTES, ...routes });
    render(<Gallery modelNames={MODEL_NAMES} initialFilter={filter} />);
    await screen.findAllByRole('img');
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    return fetchMock;
  }

  it('turns tiles into toggles, counts the selection and selects all', async () => {
    await renderSelecting({
      '/api/images': [page({ images: [tile(3), tile(2), tile(1)], jobs: [] })],
    });
    expect(screen.queryAllByRole('link', { name: /Image/ })).toHaveLength(0);
    const third = screen.getByRole('button', { name: 'Select Image 3' });
    fireEvent.click(third);
    expect(third.getAttribute('aria-pressed')).toBe('true');
    const bar = screen.getByRole('region', { name: 'Selected images' });
    expect(within(bar).getByText('1 selected')).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Select all 3' }));
    expect(within(bar).getByText('3 selected')).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    expect(within(bar).getByText('0 selected')).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'Delete' }).hasAttribute('disabled')).toBe(true);
    // Done leaves select mode.
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('region', { name: 'Selected images' })).toBeNull();
  });

  it('tags the selected images, then offers that tag for removal', async () => {
    const fetchMock = await renderSelecting({
      '/api/images': [page({ images: [tile(3), tile(2), tile(1)], jobs: [] })],
      'POST /api/images/bulk': [bulkOk],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Select Image 3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select Image 1' }));
    const bar = screen.getByRole('region', { name: 'Selected images' });
    expect(within(bar).getByRole('button', { name: 'Remove tag' }).hasAttribute('disabled')).toBe(
      true,
    );

    fireEvent.click(within(bar).getByRole('button', { name: 'Add tag' }));
    const field = await screen.findByRole('combobox', { name: 'Tag 2 images' });
    fireEvent.change(field, { target: { value: '  Golden Hour ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(sent(fetchMock, 'POST', '/api/images/bulk')).toEqual([
        { action: 'addTag', imageIds: [idOf(3), idOf(1)], tag: 'golden hour' },
      ]),
    );
    // The tiles carry the tag, so it can be removed again.
    await waitFor(() =>
      expect(within(bar).getByRole('button', { name: 'Remove tag' }).hasAttribute('disabled')).toBe(
        false,
      ),
    );
    const menu = openMenu('Remove tag');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'golden hour' }));
    await waitFor(() => expect(sent(fetchMock, 'POST', '/api/images/bulk')).toHaveLength(2));
    expect(sent(fetchMock, 'POST', '/api/images/bulk')[1]).toEqual({
      action: 'removeTag',
      imageIds: [idOf(3), idOf(1)],
      tag: 'golden hour',
    });
  });

  it('checks a tag before sending it', async () => {
    const fetchMock = await renderSelecting({
      '/api/images': [page({ images: [tile(1)], jobs: [] })],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Select Image 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add tag' }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'Tag 1 image' }), {
      target: { value: '#nope' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Tags use letters, numbers, spaces, hyphens and underscores.',
    );
    expect(sent(fetchMock, 'POST', '/api/images/bulk')).toEqual([]);
  });

  it('moves the selection out of the collection being viewed', async () => {
    const fetchMock = await renderSelecting(
      {
        [`/api/images?collection=${LOGOS}`]: [page({ images: [tile(3), tile(2)] })],
        'POST /api/images/bulk': [bulkOk],
      },
      { ...NO_FILTER, collection: LOGOS },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Select Image 3' }));
    const menu = openMenu('Move to');
    fireEvent.click(await within(menu).findByRole('menuitem', { name: 'Icons' }));
    await waitFor(() => expect(screen.queryByRole('img', { name: 'Image 3' })).toBeNull());
    expect(screen.getByRole('img', { name: 'Image 2' })).toBeTruthy();
    expect(sent(fetchMock, 'POST', '/api/images/bulk')).toEqual([
      { action: 'move', imageIds: [idOf(3)], collectionId: ICONS },
    ]);
  });

  it('deletes after confirmation, keeping the images it could not delete selected', async () => {
    const fetchMock = await renderSelecting({
      '/api/images': [page({ images: [tile(3), tile(2), tile(1)], jobs: [] })],
      'POST /api/images/bulk': [
        json({
          results: [
            { imageId: idOf(3), ok: true },
            { imageId: idOf(2), ok: false, code: 'failed', error: 'Try again.' },
          ],
        }),
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Select Image 3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select Image 2' }));
    const bar = screen.getByRole('region', { name: 'Selected images' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Delete' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Delete 2 images?' });
    expect(sent(fetchMock, 'POST', '/api/images/bulk')).toEqual([]);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete images' }));

    await waitFor(() => expect(screen.queryByRole('img', { name: 'Image 3' })).toBeNull());
    expect(screen.getByRole('img', { name: 'Image 2' })).toBeTruthy();
    expect(within(bar).getByText('1 selected')).toBeTruthy();
    expect(sent(fetchMock, 'POST', '/api/images/bulk')).toEqual([
      { action: 'delete', imageIds: [idOf(3), idOf(2)] },
    ]);
  });
});

/** The collections dialog with its data, as the gallery holds it. */
function DialogHarness({ onDeleted }: { onDeleted: (collectionId: string) => void }) {
  const data = useOrganiseData();
  return (
    <>
      <button type="button" onClick={() => void data.load()}>
        Load
      </button>
      <CollectionsDialog open onOpenChange={() => undefined} data={data} onDeleted={onDeleted} />
    </>
  );
}

describe('CollectionsDialog', () => {
  it('creates, renames and deletes collections, saying when a name is taken', async () => {
    const created: CollectionBody = {
      collectionId: idOf(903),
      name: 'Brand',
      imageCount: 0,
      createdAt: '2026-11-02T00:00:00.000Z',
    };
    const fetchMock = stubFetch({
      ...ORGANISE_ROUTES,
      'POST /api/collections': [
        json({ error: 'You already have a collection with that name.', code: 'name_taken' }, 409),
        json({ collection: created }, 201),
      ],
      [`PATCH /api/collections/${ICONS}`]: [
        json({ collection: { ...COLLECTIONS[0], name: 'Symbols' } }),
      ],
      [`DELETE /api/collections/${LOGOS}`]: [json({ collectionId: LOGOS, deleted: true })],
    });
    const onDeleted = vi.fn();
    render(<DialogHarness onDeleted={onDeleted} />);
    fireEvent.click(screen.getByText('Load'));
    const dialog = await screen.findByRole('dialog', { name: 'Collections' });
    const list = await within(dialog).findByRole('list', { name: 'Your collections' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Icons0 imagesRename IconsDelete Icons', 'Logos2 imagesRename LogosDelete Logos']);

    const name = within(dialog).getByRole('textbox', { name: 'New collection' });
    fireEvent.change(name, { target: { value: 'logos' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'You already have a collection with that name.',
    );
    fireEvent.change(name, { target: { value: 'Brand' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await within(list).findByText('Brand');
    expect(sent(fetchMock, 'POST', '/api/collections')).toEqual([
      { name: 'logos' },
      { name: 'Brand' },
    ]);

    fireEvent.click(within(list).getByRole('button', { name: 'Rename Icons' }));
    const rename = within(list).getByRole('textbox', { name: 'New name for Icons' });
    fireEvent.change(rename, { target: { value: 'Symbols' } });
    fireEvent.click(within(list).getByRole('button', { name: 'Save name' }));
    await within(list).findByText('Symbols');
    expect(sent(fetchMock, 'PATCH', `/api/collections/${ICONS}`)).toEqual([{ name: 'Symbols' }]);

    fireEvent.click(within(list).getByRole('button', { name: 'Delete Logos' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Delete Logos?' });
    expect(confirm.textContent).toContain('its images stay in your gallery');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete collection' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(LOGOS));
    expect(within(list).queryByText('Logos')).toBeNull();
  });
});

describe('ImageOrganiser', () => {
  const IMAGE_ID = idOf(1);

  it('shows the tags and automatic tags, each linking to the gallery filtered by it', () => {
    stubFetch({});
    render(
      <ImageOrganiser
        imageId={IMAGE_ID}
        tags={['sunset']}
        autoTags={['Watercolour', 'GPT Image 2']}
        collection={{ collectionId: LOGOS, name: 'Logos' }}
      />,
    );
    const tags = screen.getByRole('list', { name: 'Tags of this image' });
    expect(within(tags).getByRole('link', { name: 'sunset' }).getAttribute('href')).toBe(
      '/gallery?tag=sunset',
    );
    expect(
      within(tags).getByRole('link', { name: 'GPT Image 2, automatic tag' }).getAttribute('href'),
    ).toBe('/gallery?tag=GPT+Image+2');
    // Automatic tags can't be removed.
    expect(
      within(tags)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Remove tag sunset']);
    expect(screen.getByRole('combobox', { name: 'Collection' }).textContent).toBe('Logos');
  });

  it('adds and removes tags and moves the image, telling the gallery', async () => {
    const fetchMock = stubFetch({ ...ORGANISE_ROUTES, 'POST /api/images/bulk': [bulkOk] });
    const onChange = vi.fn();
    render(
      <ImageOrganiser imageId={IMAGE_ID} tags={['sunset']} autoTags={[]} onChange={onChange} />,
    );

    const field = screen.getByRole('combobox', { name: 'Add a tag' });
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: 'Beach' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('link', { name: 'beach' })).toBeTruthy();
    expect(onChange).toHaveBeenLastCalledWith({ tags: ['beach', 'sunset'], collection: undefined });

    fireEvent.click(screen.getByRole('button', { name: 'Remove tag sunset' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'sunset' })).toBeNull());

    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Collection' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: 'Icons' }));
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Collection' }).textContent).toBe('Icons'),
    );
    expect(onChange).toHaveBeenLastCalledWith({
      tags: ['beach'],
      collection: { collectionId: ICONS, name: 'Icons' },
    });
    expect(sent(fetchMock, 'POST', '/api/images/bulk')).toEqual([
      { action: 'addTag', imageIds: [IMAGE_ID], tag: 'beach' },
      { action: 'removeTag', imageIds: [IMAGE_ID], tag: 'sunset' },
      { action: 'move', imageIds: [IMAGE_ID], collectionId: ICONS },
    ]);
  });

  it('keeps the tags as they were when a change fails', async () => {
    stubFetch({
      ...ORGANISE_ROUTES,
      'POST /api/images/bulk': [
        json({
          results: [
            {
              imageId: IMAGE_ID,
              ok: false,
              code: 'too_many_tags',
              error: 'An image can have at most 20 tags.',
            },
          ],
        }),
      ],
    });
    const onChange = vi.fn();
    render(<ImageOrganiser imageId={IMAGE_ID} tags={[]} autoTags={[]} onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Add a tag' }), {
      target: { value: 'more' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    });
    await waitFor(() =>
      expect(
        (screen.getByRole('combobox', { name: 'Add a tag' }) as HTMLInputElement).disabled,
      ).toBe(false),
    );
    expect(screen.queryByRole('link', { name: 'more' })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('collections client', () => {
  it(`sends a big selection in requests of 50`, async () => {
    const fetchMock = stubFetch({ 'POST /api/images/bulk': [bulkOk] });
    const imageIds = Array.from({ length: 120 }, (_, n) => idOf(n + 1));
    const results = await sendBulk({ action: 'delete', imageIds });
    expect(results).toHaveLength(120);
    expect(
      sent(fetchMock, 'POST', '/api/images/bulk').map(
        (body) => (body as { imageIds: string[] }).imageIds.length,
      ),
    ).toEqual([50, 50, 20]);
  });

  it('throws the API message when a request fails as a whole', async () => {
    stubFetch({
      'POST /api/images/bulk': [json({ error: 'Collection not found.', code: 'not_found' }, 404)],
    });
    await expect(
      sendBulk({ action: 'move', imageIds: [idOf(1)], collectionId: LOGOS }),
    ).rejects.toMatchObject({ message: 'Collection not found.', status: 404, code: 'not_found' });
  });

  it('sums up a bulk change', () => {
    expect(bulkSummary('addTag', [{ imageId: idOf(1), ok: true }])).toEqual({
      message: 'Tagged 1 image.',
      failed: 0,
    });
    expect(
      bulkSummary('delete', [
        { imageId: idOf(1), ok: true },
        { imageId: idOf(2), ok: true },
        { imageId: idOf(3), ok: false, code: 'failed', error: 'Please try again.' },
      ]),
    ).toEqual({
      message: "Deleted 2 images. 1 image couldn't be changed: Please try again.",
      failed: 1,
    });
    expect(
      bulkSummary('move', [{ imageId: idOf(1), ok: false, code: 'not_found', error: 'Gone.' }]),
    ).toEqual({ message: "1 image couldn't be changed: Gone.", failed: 1 });
  });
});

describe('gallery filter', () => {
  it('reads the filter from the address and writes it back', () => {
    const filter = filterFromParams({ q: [' red fox ', 'ignored'], tag: 'GPT Image 2' });
    expect(filter).toEqual({ q: ' red fox ', tag: 'GPT Image 2', collection: '' });
    expect(galleryUrl(filter)).toBe('/gallery?q=red+fox&tag=GPT+Image+2');
    expect(galleryApiUrl({ ...filter, collection: LOGOS }, '24')).toBe(
      `/api/images?q=red+fox&tag=GPT+Image+2&collection=${LOGOS}&cursor=24`,
    );
    expect(galleryUrl(NO_FILTER)).toBe('/gallery');
    expect(galleryApiUrl(NO_FILTER)).toBe('/api/images');
  });

  it('tells a ranked view from a collection alone', () => {
    expect(isFiltered({ ...NO_FILTER, q: '   ' })).toBe(false);
    expect(isFiltered({ ...NO_FILTER, collection: LOGOS })).toBe(true);
    expect(isRanked({ ...NO_FILTER, collection: LOGOS })).toBe(false);
    expect(isRanked({ ...NO_FILTER, tag: 'sunset' })).toBe(true);
  });
});
