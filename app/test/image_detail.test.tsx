// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageDetail } from '../src/components/image_detail';
import type { ImageDetailBody, ImageVersionBody } from '../src/lib/images';
import { IMAGES_CHANGED_EVENT } from '../src/lib/images_changed';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const IMAGE_ID = '01JAAAAAAAAAAAAAAAAAAAAAAA';
const MODEL_NAMES = { mock: 'Mock (dev only)', 'gpt-image-2': 'GPT Image 2' };

function version(n: number, fields: Partial<ImageVersionBody> = {}): ImageVersionBody {
  return {
    version: n,
    width: 1024,
    height: 768,
    url: `https://signed.example/v${n}.png`,
    downloadUrl: `https://signed.example/v${n}.png?download`,
    thumbUrl: `https://signed.example/v${n}_thumb.webp`,
    createdAt: '2026-10-15T12:30:00.000Z',
    ...fields,
  };
}

const ORIGINAL = version(1, {
  prompt: 'A lighthouse at dusk',
  enhancedPrompt: 'A lighthouse at dusk, warm light over a calm sea',
  modelId: 'mock',
  style: 'watercolour',
  quality: 'draft',
  aspect: '4:5',
  seed: 42,
});
const NIGHT = version(2, {
  parentVersion: 1,
  editInstruction: 'Make it night',
  modelId: 'gpt-image-2',
  quality: 'standard',
});

function detail(versions: ImageVersionBody[], fields: Partial<ImageDetailBody['image']> = {}) {
  return {
    image: {
      imageId: IMAGE_ID,
      title: 'A lighthouse at dusk',
      latestVersion: versions.at(-1)?.version ?? 1,
      versionCount: versions.length,
      ...fields,
    },
    versions,
  } satisfies ImageDetailBody;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The detail's settings, as label → value. */
function fields(): Record<string, string> {
  const list = document.querySelector('.detail-fields')!;
  return Object.fromEntries(
    [...list.querySelectorAll('div')].map((row) => [
      row.querySelector('dt')!.textContent,
      row.querySelector('dd')!.textContent,
    ]),
  );
}

describe('ImageDetail', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    push.mockReset();
  });

  it('shows the latest version with its settings, and every version to switch to', () => {
    render(
      <ImageDetail
        imageId={IMAGE_ID}
        initial={detail([ORIGINAL, NIGHT])}
        modelNames={MODEL_NAMES}
        headingLevel={1}
        onDeleted={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'A lighthouse at dusk' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Version 2' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Make it night' }).getAttribute('src')).toBe(
      'https://signed.example/v2.png',
    );
    expect(fields()).toEqual({
      Edit: 'Make it night',
      'Edited from': 'Version 1',
      Model: 'GPT Image 2',
      Size: '1024 × 768',
      Quality: 'Standard',
      Created: '15 October 2026 at 12:30 UTC',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Version 1' }));
    expect(screen.getByRole('button', { name: 'Version 1' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(fields()).toEqual({
      Prompt: 'A lighthouse at dusk',
      'Enhanced prompt': 'A lighthouse at dusk, warm light over a calm sea',
      Model: 'Mock (dev only)',
      Style: 'Watercolour',
      Size: '1024 × 768 (4:5)',
      Quality: 'Draft',
      Seed: '42',
      Created: '15 October 2026 at 12:30 UTC',
    });
  });

  it('shows the versions as a row under the picture, not in the details column (#125)', () => {
    render(
      <ImageDetail
        imageId={IMAGE_ID}
        initial={detail([ORIGINAL, NIGHT])}
        modelNames={MODEL_NAMES}
        onDeleted={vi.fn()}
      />,
    );
    const picture = screen.getByRole('img', { name: 'Make it night' });
    const picker = screen.getByRole('group', { name: 'Version picker' });
    // The picker shares the viewer with the picture, and comes after it.
    expect(picture.parentElement?.contains(picker)).toBe(true);
    expect(picture.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const details = document.querySelector('.detail-fields')!;
    expect(details.parentElement?.querySelector('[aria-label="Versions"]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Previous version' }));
    expect(screen.getByRole('img', { name: 'A lighthouse at dusk' })).toBeTruthy();
  });

  it('offers download, rerun, edit and report for the selected version', () => {
    render(
      <ImageDetail
        imageId={IMAGE_ID}
        initial={detail([ORIGINAL, NIGHT])}
        modelNames={MODEL_NAMES}
        onDeleted={vi.fn()}
      />,
    );
    const download = screen.getByRole('link', { name: 'Download PNG' });
    expect(download.getAttribute('href')).toBe(`/api/images/${IMAGE_ID}/versions/2/download`);
    expect(download.hasAttribute('download')).toBe(true);
    expect(screen.getByRole('link', { name: 'Rerun' }).getAttribute('href')).toBe(
      `/generate?rerun=${IMAGE_ID}`,
    );
    expect(screen.getByRole('link', { name: 'Edit' }).getAttribute('href')).toBe(
      `/edit/${IMAGE_ID}?version=2`,
    );
    expect(screen.getByRole('button', { name: 'Report' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Version 1' }));
    expect(screen.getByRole('link', { name: 'Edit' }).getAttribute('href')).toBe(
      `/edit/${IMAGE_ID}?version=1`,
    );
  });

  it('has no rerun for an uploaded image, and no version list for a single version', () => {
    render(
      <ImageDetail
        imageId={IMAGE_ID}
        initial={detail([version(1, { source: 'upload' })], { source: 'upload' })}
        modelNames={MODEL_NAMES}
        onDeleted={vi.fn()}
      />,
    );
    expect(screen.queryByRole('link', { name: 'Rerun' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Versions' })).toBeNull();
    expect(fields()).toMatchObject({ Source: 'Uploaded image' });
  });

  it('fetches the detail when it is not given, showing loading and error states', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ error: 'Image not found.' }, 404))
      .mockResolvedValueOnce(json(detail([ORIGINAL])));
    vi.stubGlobal('fetch', fetchMock);
    render(<ImageDetail imageId={IMAGE_ID} modelNames={MODEL_NAMES} onDeleted={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toBe('Loading image…');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("We couldn't load this image.");
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'A lighthouse at dusk' })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(`/api/images/${IMAGE_ID}`, { cache: 'no-store' });
  });

  it('asks for confirmation before deleting, and can be cancelled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const onDeleted = vi.fn();
    render(
      <ImageDetail
        imageId={IMAGE_ID}
        initial={detail([ORIGINAL, NIGHT])}
        modelNames={MODEL_NAMES}
        onDeleted={onDeleted}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const confirm = screen.getByRole('alertdialog');
    expect(confirm.textContent).toContain(
      "Delete this image and all 2 versions? This can't be undone.",
    );
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('deletes after confirmation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ imageId: IMAGE_ID, deleted: true }));
    vi.stubGlobal('fetch', fetchMock);
    const onDeleted = vi.fn();
    const imagesChanged = vi.fn();
    window.addEventListener(IMAGES_CHANGED_EVENT, imagesChanged);
    render(
      <ImageDetail
        imageId={IMAGE_ID}
        initial={detail([ORIGINAL])}
        modelNames={MODEL_NAMES}
        onDeleted={onDeleted}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('alertdialog').textContent).toContain(
      "Delete this image? This can't be undone.",
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete image' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(IMAGE_ID));
    expect(fetchMock).toHaveBeenCalledWith(`/api/images/${IMAGE_ID}`, { method: 'DELETE' });
    // The sidebar history drops it.
    expect(imagesChanged).toHaveBeenCalledOnce();
    window.removeEventListener(IMAGES_CHANGED_EVENT, imagesChanged);
  });

  it('says so when the delete fails, and keeps the image', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ error: "We couldn't delete your image." }, 503)),
    );
    const onDeleted = vi.fn();
    render(
      <ImageDetail
        imageId={IMAGE_ID}
        initial={detail([ORIGINAL])}
        modelNames={MODEL_NAMES}
        onDeleted={onDeleted}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete image' }));
    const alert = await within(screen.getByRole('alertdialog')).findByRole('alert');
    expect(alert.textContent).toBe("We couldn't delete your image.");
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('fetches fresh URLs when the image fails to load after they may have expired', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const fresh = detail([version(1, { ...ORIGINAL, url: 'https://signed.example/fresh.png' })]);
    const fetchMock = vi.fn().mockResolvedValue(json(fresh));
    vi.stubGlobal('fetch', fetchMock);
    render(
      <ImageDetail
        imageId={IMAGE_ID}
        initial={detail([ORIGINAL])}
        modelNames={MODEL_NAMES}
        onDeleted={vi.fn()}
      />,
    );
    const image = screen.getByRole('img', { name: 'A lighthouse at dusk' });
    fireEvent.error(image);
    expect(fetchMock).not.toHaveBeenCalled();

    now.mockReturnValue(1_000_000 + 16 * 60_000);
    fireEvent.error(image);
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'A lighthouse at dusk' }).getAttribute('src')).toBe(
        'https://signed.example/fresh.png',
      ),
    );
    now.mockRestore();
  });
});
