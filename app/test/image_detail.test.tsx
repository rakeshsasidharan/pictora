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
  const list = document.querySelector('[data-slot="detail-fields"]')!;
  return Object.fromEntries(
    [...list.querySelectorAll(':scope > div')].map((row) => {
      const value = row.querySelector('dd')!;
      // Long text sits in a scroll area, whose root also holds Radix's style tag.
      const viewport = value.querySelector('[data-slot="scroll-area-viewport"]');
      return [row.querySelector('dt')!.textContent, (viewport ?? value).textContent];
    }),
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

  describe('alt text (#30)', () => {
    const renderDetail = (versions: ImageVersionBody[]) =>
      render(
        <ImageDetail
          imageId={IMAGE_ID}
          initial={detail(versions)}
          modelNames={MODEL_NAMES}
          onDeleted={vi.fn()}
        />,
      );
    const altGroup = () => screen.getByRole('group', { name: 'Alt text' });
    const picture = () =>
      document.querySelector<HTMLImageElement>('[data-slot="image-detail"] img')!;

    it('falls back to the prompt, then the edit instruction, trimmed to 150 characters', () => {
      const long = version(1, { prompt: `A lighthouse ${'at dusk, '.repeat(30)}` });
      renderDetail([long, NIGHT]);
      expect(picture().getAttribute('alt')).toBe('Make it night');
      expect(within(altGroup()).getByText('Make it night')).toBeTruthy();
      expect(within(altGroup()).getByText('From the edit instruction.')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Version 1' }));
      const alt = picture().getAttribute('alt')!;
      expect(alt.startsWith('A lighthouse at dusk, at dusk')).toBe(true);
      expect(alt.length).toBeLessThanOrEqual(150);
      expect(alt.endsWith('…')).toBe(true);
      expect(within(altGroup()).getByText('From the prompt.')).toBeTruthy();
    });

    it('describes an upload as an uploaded image', () => {
      renderDetail([version(1, { source: 'upload' })]);
      expect(picture().getAttribute('alt')).toBe('Uploaded image');
      expect(within(altGroup()).getByText('The default for an upload.')).toBeTruthy();
    });

    it("uses the user's own alt text over the default", () => {
      renderDetail([ORIGINAL, { ...NIGHT, altText: 'A lighthouse under a starry night sky' }]);
      expect(picture().getAttribute('alt')).toBe('A lighthouse under a starry night sky');
      expect(within(altGroup()).getByText('Written by you.')).toBeTruthy();
      // The version row's thumbnails use it too.
      expect(screen.getByRole('button', { name: 'Version 2' }).getAttribute('title')).toBe(
        'A lighthouse under a starry night sky',
      );
    });

    it('saves the alt text the user writes, then goes back to the default', async () => {
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const { altText } = JSON.parse(init!.body as string) as { altText: string | null };
        return json({ imageId: IMAGE_ID, version: 2, altText });
      });
      vi.stubGlobal('fetch', fetchMock);
      renderDetail([ORIGINAL, NIGHT]);

      fireEvent.click(within(altGroup()).getByRole('button', { name: 'Edit alt text' }));
      const box = within(altGroup()).getByRole('textbox', { name: 'Alt text' });
      expect(document.activeElement).toBe(box);
      expect((box as HTMLTextAreaElement).value).toBe('Make it night');
      fireEvent.change(box, { target: { value: '  A lighthouse at night  ' } });
      fireEvent.click(within(altGroup()).getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(picture().getAttribute('alt')).toBe('A lighthouse at night'));
      expect(fetchMock).toHaveBeenCalledWith(`/api/images/${IMAGE_ID}/versions/2`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ altText: 'A lighthouse at night' }),
      });
      expect(within(altGroup()).getByText('Written by you.')).toBeTruthy();

      fireEvent.click(within(altGroup()).getByRole('button', { name: 'Edit alt text' }));
      fireEvent.click(within(altGroup()).getByRole('button', { name: 'Use the default' }));
      await waitFor(() => expect(picture().getAttribute('alt')).toBe('Make it night'));
      expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual({ altText: null });
      expect(within(altGroup()).getByText('From the edit instruction.')).toBeTruthy();
    });

    it('asks for some text, shows a failed save, and can be cancelled', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          json({ code: 'rate_limited', error: 'Wait a moment, then try again.' }, 429),
        ),
      );
      renderDetail([ORIGINAL, NIGHT]);
      fireEvent.click(within(altGroup()).getByRole('button', { name: 'Edit alt text' }));
      const box = within(altGroup()).getByRole('textbox', { name: 'Alt text' });
      fireEvent.change(box, { target: { value: '   ' } });
      fireEvent.click(within(altGroup()).getByRole('button', { name: 'Save' }));
      expect(within(altGroup()).getByRole('alert').textContent).toBe(
        'Write some alt text, or use the default.',
      );
      expect(box.getAttribute('aria-invalid')).toBe('true');

      fireEvent.change(box, { target: { value: 'A lighthouse at night' } });
      fireEvent.click(within(altGroup()).getByRole('button', { name: 'Save' }));
      expect((await within(altGroup()).findByRole('alert')).textContent).toBe(
        'Wait a moment, then try again.',
      );
      expect(picture().getAttribute('alt')).toBe('Make it night');

      fireEvent.click(within(altGroup()).getByRole('button', { name: 'Cancel' }));
      expect(within(altGroup()).queryByRole('textbox')).toBeNull();
      expect(within(altGroup()).getByText('Make it night')).toBeTruthy();
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
    const details = document.querySelector('[data-slot="detail-fields"]')!;
    expect(details.parentElement?.querySelector('[aria-label="Versions"]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Previous version' }));
    expect(screen.getByRole('img', { name: 'A lighthouse at dusk' })).toBeTruthy();
  });

  it('shows the prompt and the enhanced prompt in capped scroll areas the keyboard can reach (#145)', () => {
    render(
      <ImageDetail
        imageId={IMAGE_ID}
        initial={detail([ORIGINAL])}
        modelNames={MODEL_NAMES}
        onDeleted={vi.fn()}
      />,
    );
    for (const [label, text] of [
      ['Prompt', ORIGINAL.prompt],
      ['Enhanced prompt', ORIGINAL.enhancedPrompt],
    ] as const) {
      const box = screen.getByRole('group', { name: label });
      expect(box.getAttribute('data-slot')).toBe('scroll-area-viewport');
      expect(box.closest('[data-slot="scroll-area"]')).toBeTruthy();
      expect(box.className).toContain('max-h-32');
      expect(box.tabIndex).toBe(0);
      expect(box.textContent).toBe(text);
    }
    // Short settings are plain text.
    expect(screen.queryByRole('group', { name: 'Model' })).toBeNull();
  });

  it('puts a 2,000-character prompt in the same capped scroll area as a short one', () => {
    const long = 'A lighthouse at dusk with gulls overhead. '.repeat(50).slice(0, 2000);
    render(
      <ImageDetail
        imageId={IMAGE_ID}
        initial={detail([{ ...ORIGINAL, prompt: long, enhancedPrompt: undefined }])}
        modelNames={MODEL_NAMES}
        onDeleted={vi.fn()}
      />,
    );
    const box = screen.getByRole('group', { name: 'Prompt' });
    expect(box.textContent).toBe(long);
    expect(box.className).toContain('max-h-32');
    // The picture and the actions are outside the scroll area.
    expect(box.contains(screen.getByRole('link', { name: 'Download PNG' }))).toBe(false);
    expect(box.contains(screen.getByRole('img', { name: /lighthouse/ }))).toBe(false);
  });

  it('puts an edit instruction in a scroll area too', () => {
    render(
      <ImageDetail
        imageId={IMAGE_ID}
        initial={detail([ORIGINAL, NIGHT])}
        modelNames={MODEL_NAMES}
        onDeleted={vi.fn()}
      />,
    );
    expect(screen.getByRole('group', { name: 'Edit' }).textContent).toBe('Make it night');
  });

  it('fills its container in the modal, and sizes to its content on the page', () => {
    const { unmount } = render(
      <ImageDetail
        imageId={IMAGE_ID}
        initial={detail([ORIGINAL])}
        modelNames={MODEL_NAMES}
        onDeleted={vi.fn()}
        fill
      />,
    );
    const filled = document.querySelector<HTMLElement>('[data-slot="image-detail"]')!;
    expect(filled.className).toContain('flex-1');
    expect(screen.getByRole('img', { name: /lighthouse/ }).className).toContain('flex-1');
    unmount();

    render(
      <ImageDetail
        imageId={IMAGE_ID}
        initial={detail([ORIGINAL])}
        modelNames={MODEL_NAMES}
        headingLevel={1}
        onDeleted={vi.fn()}
      />,
    );
    const page = document.querySelector<HTMLElement>('[data-slot="image-detail"]')!;
    expect(page.className).not.toContain('flex-1');
    expect(screen.getByRole('img', { name: /lighthouse/ }).className).toContain('max-h-[70svh]');
    // The page has the same capped scroll area.
    expect(screen.getByRole('group', { name: 'Prompt' }).className).toContain('max-h-32');
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
    const confirm = screen.getByRole('alertdialog', {
      name: 'Delete this image and all 2 versions?',
    });
    expect(confirm.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(confirm.getAttribute('aria-describedby')!)?.textContent).toBe(
      "This can't be undone.",
    );
    // Cancel takes the focus, so Enter doesn't delete by mistake.
    const cancel = within(confirm).getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
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
    const confirm = screen.getByRole('alertdialog', { name: 'Delete this image?' });
    expect(confirm.textContent).toContain("This can't be undone.");
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete image' }));
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
