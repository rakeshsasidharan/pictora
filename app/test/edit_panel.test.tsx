// @vitest-environment jsdom
import { loadSeedRegistry, modelsForEnvironment } from '@pictora/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditPanel } from '../src/components/edit_panel';
import type { ImageDetailBody, ImageVersionBody } from '../src/lib/images';
import { modelsResponse, type PublicModel } from '../src/lib/models_response';
import type { UploadClient } from '../src/lib/upload_client';

const { models } = modelsResponse(modelsForEnvironment(loadSeedRegistry(), 'dev'));
const IMAGE_ID = '01JAAAAAAAAAAAAAAAAAAAAAAA';
const JOB_ID = '01JBBBBBBBBBBBBBBBBBBBBBBB';

function version(n: number, fields: Partial<ImageVersionBody> = {}): ImageVersionBody {
  return {
    version: n,
    width: 1024,
    height: 1024,
    url: `https://signed.example/v${n}.png`,
    downloadUrl: `https://signed.example/v${n}.png?download`,
    thumbUrl: `https://signed.example/v${n}_thumb.webp`,
    ...fields,
  };
}

function detail(versions: ImageVersionBody[]): ImageDetailBody {
  return {
    image: {
      imageId: IMAGE_ID,
      title: 'A lighthouse at dusk',
      latestVersion: versions.at(-1)?.version ?? 1,
      versionCount: versions.length,
    },
    versions,
  };
}

const ORIGINAL = version(1, { prompt: 'A lighthouse at dusk' });
const NIGHT = version(2, { parentVersion: 1, editInstruction: 'Make it night' });
const STARS = version(3, { parentVersion: 2, editInstruction: 'Add stars' });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A fetch stand-in for job creation, job polls, the image detail and the points. */
function stubApi(options: {
  created?: Response;
  statuses?: Record<string, unknown>[];
  detailAfter?: ImageDetailBody;
}) {
  const statuses = [...(options.statuses ?? [])];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/jobs' && init?.method === 'POST') {
      return options.created ?? json({ jobId: JOB_ID, status: 'queued', pointsReserved: 1 }, 202);
    }
    if (url === `/api/jobs/${JOB_ID}`) {
      const next = statuses.length > 1 ? statuses.shift() : statuses[0];
      return json({ jobId: JOB_ID, type: 'edit', pointsReserved: 1, ...next });
    }
    if (url === `/api/images/${IMAGE_ID}`) return json(options.detailAfter ?? {});
    if (url === '/api/me') return json({ pointsLeft: 24, dailyLimit: 25 });
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function jobBodies(fetchMock: ReturnType<typeof stubApi>): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([url, init]) => url === '/api/jobs' && init?.method === 'POST')
    .map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>);
}

function renderPanel(
  props: Partial<Parameters<typeof EditPanel>[0]> = {},
  versions = [ORIGINAL, NIGHT, STARS],
) {
  return render(
    <EditPanel
      detail={detail(versions)}
      models={models}
      points={{ left: 25, limit: 25 }}
      pollIntervalMs={5}
      pollTimeoutMs={2_000}
      {...props}
    />,
  );
}

const instruction = () => screen.getByRole('textbox', { name: 'Describe your change' });
const versionButton = (n: number) => screen.getByRole('button', { name: `Version ${n}` });
const apply = () => screen.getByRole('button', { name: /Apply edit|Starting|Editing/ });
const modelSelect = () => screen.getByRole<HTMLSelectElement>('combobox', { name: 'Model' });

describe('EditPanel', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists the versions with their instructions and shows the latest', () => {
    renderPanel();
    const list = screen.getByRole('list', { name: 'Versions' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Version 1A lighthouse at dusk',
      'Version 2Make it nightEdited from version 1',
      'Version 3Add starsEdited from version 2',
    ]);
    expect(versionButton(3).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Version 3' })).toBeTruthy();
    expect(screen.getByRole<HTMLImageElement>('img', { name: 'Add stars' }).src).toBe(STARS.url);
    expect(screen.getByRole('link', { name: 'Download PNG' }).getAttribute('href')).toBe(
      STARS.downloadUrl,
    );
  });

  it('starts on Gemini 3.1 Flash Image and shows the cost before submitting', () => {
    renderPanel();
    expect(modelSelect().value).toBe('gemini-3.1-flash-image');
    // Only models that can edit are offered.
    const options = within(modelSelect())
      .getAllByRole('option')
      .map((option) => option.getAttribute('value'));
    expect(options).not.toContain('stable-image-core');
    expect(options).toContain('gpt-image-2');
    const gemini = models.find((model) => model.id === 'gemini-3.1-flash-image');
    const standard = gemini?.qualities.find((option) => option.quality === 'standard');
    expect(screen.getByText(`Uses ${standard?.costPoints} of your 25 points today`)).toBeTruthy();
  });

  it('views, downloads and edits from an earlier version, branching from it', async () => {
    const fetchMock = stubApi({
      statuses: [
        { status: 'running' },
        { status: 'succeeded', images: [{ imageId: IMAGE_ID, version: 4 }] },
      ],
      detailAfter: detail([
        ORIGINAL,
        NIGHT,
        STARS,
        version(4, { parentVersion: 1, editInstruction: 'Add snow' }),
      ]),
    });
    renderPanel();
    fireEvent.click(versionButton(1));
    expect(versionButton(1).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('link', { name: 'Download PNG' }).getAttribute('href')).toBe(
      ORIGINAL.downloadUrl,
    );
    expect(screen.getByText('Edits version 1. Earlier versions are always kept.')).toBeTruthy();

    fireEvent.change(modelSelect(), { target: { value: 'mock' } });
    fireEvent.change(instruction(), { target: { value: 'Add snow' } });
    fireEvent.click(apply());

    await waitFor(() => expect(jobBodies(fetchMock)).toHaveLength(1));
    expect(jobBodies(fetchMock)[0]).toEqual({
      type: 'edit',
      imageId: IMAGE_ID,
      parentVersion: 1,
      instruction: 'Add snow',
      modelId: 'mock',
      quality: 'standard',
    });
    expect(await screen.findByText('From version 1')).toBeTruthy();

    // The new version appears, selected, when the job finishes.
    await waitFor(() => expect(versionButton(4).getAttribute('aria-pressed')).toBe('true'));
    expect(within(versionButton(4)).getByText('Edited from version 1')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Version 4' })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('24 of 25 points left today')).toBeTruthy());
  });

  it('asks for an instruction before submitting', () => {
    const fetchMock = stubApi({});
    renderPanel();
    fireEvent.click(apply());
    expect(screen.getByRole('alert').textContent).toBe('Describe the change you want.');
    expect(jobBodies(fetchMock)).toHaveLength(0);
  });

  it('shows why an edit failed and the refund', async () => {
    stubApi({
      statuses: [
        { status: 'failed', pointsCharged: 0, error: 'The image model ran into a problem.' },
      ],
    });
    renderPanel();
    fireEvent.change(instruction(), { target: { value: 'Make it night' } });
    fireEvent.click(apply());
    const alert = await screen.findByText('The image model ran into a problem.');
    expect(alert.closest('[role="alert"]')?.textContent).toMatch(/1 point returned/);
    expect(
      within(screen.getByRole('list', { name: 'Versions' })).getAllByRole('listitem'),
    ).toHaveLength(3);
  });

  it('shows the API error when the edit is refused', async () => {
    stubApi({ created: json({ error: 'Image not found.', code: 'not_found' }, 404) });
    renderPanel();
    fireEvent.change(instruction(), { target: { value: 'Make it night' } });
    fireEvent.click(apply());
    expect((await screen.findByRole('alert')).textContent).toBe('Image not found.');
  });

  it('uploads reference images and sends their keys with the edit', async () => {
    const fetchMock = stubApi({ statuses: [{ status: 'queued' }] });
    const uploadClient: UploadClient = {
      start: vi.fn(async () => ({
        uploadId: '01JCCCCCCCCCCCCCCCCCCCCCCC',
        key: 'uploads/sub/01JCCCCCCCCCCCCCCCCCCCCCCC',
        url: 'https://bucket.example/',
        fields: {},
      })),
      send: vi.fn(async (_ticket, _file, onProgress) => onProgress(100)),
      complete: vi.fn(),
    };
    renderPanel({ uploadClient });
    const input = screen.getByLabelText('Choose a reference image to upload');
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'style.png', { type: 'image/png' })] },
    });
    const list = await screen.findByRole('list', { name: 'Reference images' });
    expect(within(list).getByText('style.png')).toBeTruthy();
    // A reference stays a raw upload: it is never completed into a gallery image.
    expect(uploadClient.complete).not.toHaveBeenCalled();

    fireEvent.change(instruction(), { target: { value: 'In this style' } });
    fireEvent.click(apply());
    await waitFor(() => expect(jobBodies(fetchMock)).toHaveLength(1));
    expect(jobBodies(fetchMock)[0]?.referenceKeys).toEqual([
      'uploads/sub/01JCCCCCCCCCCCCCCCCCCCCCCC',
    ]);
  });

  it('refuses a reference that is not an image of up to 10 MB', async () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText('Choose a reference image to upload'), {
      target: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] },
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(/JPEG, PNG or WebP/);
  });

  it('hides reference images for a model that takes none', () => {
    const noReferences: PublicModel[] = models.map((model) =>
      model.id === 'gpt-image-2'
        ? { ...model, capabilities: { ...model.capabilities, referenceImages: 0 } }
        : model,
    );
    renderPanel({ models: noReferences });
    expect(screen.getByRole('group', { name: 'Reference images (optional)' })).toBeTruthy();
    fireEvent.change(modelSelect(), { target: { value: 'gpt-image-2' } });
    expect(screen.queryByRole('group', { name: 'Reference images (optional)' })).toBeNull();
  });

  it('says choosing a reference from the gallery is coming soon', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Choose from gallery' }));
    const toast = screen.getByText('Gallery coming soon.').closest('.toast') as HTMLElement;
    expect(within(toast).getByRole('link').getAttribute('href')).toMatch(/\/issues\/23$/);
  });

  it('starts from the version asked for', () => {
    renderPanel({ initialVersion: 2 });
    expect(versionButton(2).getAttribute('aria-pressed')).toBe('true');
  });

  it('disables the edit when the points left are too few', () => {
    renderPanel({ points: { left: 0, limit: 25 } });
    expect((apply() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/don't have enough points left today/)).toBeTruthy();
  });

  it('says so when no model can edit', () => {
    renderPanel({ models: models.filter((model) => !model.capabilities.edit) });
    expect(screen.getByRole('alert').textContent).toMatch(/No image models can edit/);
  });
});
