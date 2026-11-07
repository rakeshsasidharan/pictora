// @vitest-environment jsdom
import { loadSeedRegistry } from '@pictora/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageTools, type ImageToolsProps } from '../src/components/image_tools';
import { MaskEditor } from '../src/components/mask_editor';
import type { ImageVersionBody } from '../src/lib/images';
import type { MaskStroke } from '../src/lib/mask';
import { toolsFor, type ToolCatalog } from '../src/lib/tool_catalog';
import type { UploadClient } from '../src/lib/upload_client';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const IMAGE_ID = '01JAAAAAAAAAAAAAAAAAAAAAAA';
const JOB_ID = '01JJJJJJJJJJJJJJJJJJJJJJJJ';

const catalog: ToolCatalog = toolsFor(loadSeedRegistry(), [], () => true);

function version(overrides: Partial<ImageVersionBody> = {}): ImageVersionBody {
  return {
    version: 2,
    prompt: 'A lighthouse at dusk',
    width: 1000,
    height: 500,
    url: 'https://signed.example/v2.png',
    downloadUrl: 'https://signed.example/v2.png?download',
    thumbUrl: 'https://signed.example/v2.webp',
    ...overrides,
  };
}

/** The canvas the mask editor draws on, 1000 px wide on screen, so screen and image pixels match. */
function stubCanvasLayout(canvas: HTMLElement) {
  canvas.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: 1000,
      height: 500,
      right: 1000,
      bottom: 500,
      x: 0,
      y: 0,
    }) as DOMRect;
}

/** Paints one stroke from (x1, y1) to (x2, y2) on the canvas. */
function paint(canvas: HTMLElement, from: [number, number], to?: [number, number]) {
  fireEvent.pointerDown(canvas, { clientX: from[0], clientY: from[1], button: 0, pointerId: 1 });
  if (to) fireEvent.pointerMove(canvas, { clientX: to[0], clientY: to[1], pointerId: 1 });
  fireEvent.pointerUp(canvas, { pointerId: 1 });
}

beforeEach(() => {
  // jsdom has no 2D canvas; the editor draws nothing then, but keeps its strokes.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  toast.success.mockReset();
});

describe('MaskEditor', () => {
  function Harness({ onChange }: { onChange?: (strokes: MaskStroke[]) => void }) {
    const [strokes, setStrokes] = useState<MaskStroke[]>([]);
    return (
      <MaskEditor
        imageUrl="https://signed.example/v2.png"
        imageAlt="A lighthouse at dusk"
        width={1000}
        height={500}
        strokes={strokes}
        onStrokesChange={(next) => {
          setStrokes(next);
          onChange?.(next);
        }}
      />
    );
  }

  const canvas = () => screen.getByRole('img', { name: /^Erase mask/ });

  it('draws strokes in image pixels, with the chosen brush size', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    stubCanvasLayout(canvas());
    paint(canvas(), [100, 100], [200, 150]);
    expect(onChange).toHaveBeenLastCalledWith([
      {
        size: 50,
        points: [
          { x: 100, y: 100 },
          { x: 200, y: 150 },
        ],
      },
    ]);
    fireEvent.click(screen.getByRole('radio', { name: 'Large brush' }));
    paint(canvas(), [500, 250]);
    expect(onChange.mock.lastCall?.[0]).toHaveLength(2);
    expect(onChange.mock.lastCall?.[0][1]).toEqual({ size: 100, points: [{ x: 500, y: 250 }] });
    expect(canvas().getAttribute('aria-label')).toMatch(/^Erase mask: 2 strokes/);
  });

  it('undoes the last stroke, then clears them all', () => {
    render(<Harness />);
    stubCanvasLayout(canvas());
    const undo = screen.getByRole('button', { name: 'Undo' });
    const clear = screen.getByRole('button', { name: 'Clear' });
    expect(undo.hasAttribute('disabled')).toBe(true);
    expect(clear.hasAttribute('disabled')).toBe(true);

    paint(canvas(), [10, 10], [20, 20]);
    paint(canvas(), [30, 30]);
    paint(canvas(), [40, 40], [60, 60]);
    expect(canvas().getAttribute('data-strokes')).toBe('3');
    fireEvent.click(undo);
    expect(canvas().getAttribute('data-strokes')).toBe('2');
    fireEvent.click(clear);
    expect(canvas().getAttribute('data-strokes')).toBe('0');
    expect(undo.hasAttribute('disabled')).toBe(true);
  });
});

describe('ImageTools', () => {
  type Answer = { status: number; body: unknown };
  let jobAnswers: Answer[];
  let posted: unknown[];

  function stubFetch(options: { pointsLeft?: number; create?: Answer } = {}) {
    posted = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/me') {
        return Response.json({ pointsLeft: options.pointsLeft ?? 20, dailyLimit: 25 });
      }
      if (url === '/api/jobs') {
        posted.push(JSON.parse(String(init?.body)));
        const answer = options.create ?? {
          status: 202,
          body: { jobId: JOB_ID, status: 'queued', pointsReserved: 3, modelId: 'x' },
        };
        return Response.json(answer.body, { status: answer.status });
      }
      if (url.startsWith('/api/jobs/')) {
        const answer = jobAnswers.shift() ?? {
          status: 200,
          body: { jobId: JOB_ID, status: 'running' },
        };
        return Response.json(answer.body, { status: answer.status });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function renderTools(props: Partial<ImageToolsProps> = {}) {
    const onCreated = vi.fn();
    render(
      <ImageTools
        imageId={IMAGE_ID}
        version={version()}
        catalog={catalog}
        onCreated={onCreated}
        pollIntervalMs={1}
        {...props}
      />,
    );
    return { onCreated };
  }

  function openTool(label: string): HTMLElement {
    fireEvent.keyDown(screen.getByRole('button', { name: 'Tools' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: label }));
    return screen.getByRole('dialog', { name: label });
  }

  beforeEach(() => {
    jobAnswers = [];
  });

  it('lists each tool the catalogue offers in the Tools menu', () => {
    stubFetch();
    renderTools();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Tools' }), { key: 'Enter' });
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Upscale',
      'Remove background',
      'Erase object',
      'Outpaint',
    ]);
  });

  it('offers only the tools in the catalogue, and nothing without any', () => {
    stubFetch();
    const only = { tools: catalog.tools.filter((tool) => tool.id === 'outpaint') };
    renderTools({ catalog: only });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Tools' }), { key: 'Enter' });
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Outpaint']);
    cleanup();
    renderTools({ catalog: { tools: [] } });
    expect(screen.queryByRole('button', { name: 'Tools' })).toBeNull();
  });

  it('shows each upscale mode with its cost, and a prompt for the conservative and creative ones', async () => {
    stubFetch({ pointsLeft: 20 });
    renderTools();
    const dialog = openTool('Upscale');
    const labels = within(dialog)
      .getAllByRole('radio')
      .map((radio) => document.querySelector(`label[for="${radio.id}"]`)?.textContent);
    expect(labels).toEqual(['Fast · 3 points', 'Conservative · 40 points', 'Creative · 60 points']);
    expect(within(dialog).queryByLabelText('Describe the picture (optional)')).toBeNull();
    await waitFor(() =>
      expect(dialog.querySelector('[data-slot="tool-cost"]')?.textContent).toBe(
        'Costs 3 points of your 20 points left today.',
      ),
    );
    expect(within(dialog).getByRole('button', { name: 'Run · 3 points' })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('radio', { name: /Creative/ }));
    const prompt = within(dialog).getByLabelText('Describe the picture (optional)');
    expect((prompt as HTMLTextAreaElement).value).toBe('A lighthouse at dusk');
    expect(dialog.querySelector('[data-slot="tool-cost"]')?.textContent).toBe(
      "Costs 60 points of your 20 points left today. That's more than you have left today.",
    );
    expect(
      within(dialog).getByRole('button', { name: 'Run · 60 points' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('runs an upscale on the version shown, then moves the view to the new version', async () => {
    stubFetch();
    jobAnswers = [
      { status: 200, body: { jobId: JOB_ID, status: 'running' } },
      {
        status: 200,
        body: {
          jobId: JOB_ID,
          status: 'succeeded',
          images: [{ imageId: IMAGE_ID, version: 3, url: 'u', downloadUrl: 'd' }],
        },
      },
    ];
    const { onCreated } = renderTools();
    const dialog = openTool('Upscale');
    await waitFor(() =>
      expect(dialog.querySelector('[data-slot="tool-cost"]')?.textContent).toMatch(/left today/),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run · 3 points' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(3));
    expect(posted).toEqual([
      { type: 'tool', imageId: IMAGE_ID, version: 2, tool: 'upscale', params: { mode: 'fast' } },
    ]);
    expect(toast.success).toHaveBeenCalledWith('Fast upscale done: version 3');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('sends the creative upscale its prompt', async () => {
    stubFetch({ pointsLeft: 100 });
    renderTools();
    const dialog = openTool('Upscale');
    fireEvent.click(within(dialog).getByRole('radio', { name: /Creative/ }));
    fireEvent.change(within(dialog).getByLabelText('Describe the picture (optional)'), {
      target: { value: 'A red lighthouse' },
    });
    await waitFor(() =>
      expect(
        within(dialog).getByRole('button', { name: 'Run · 60 points' }).hasAttribute('disabled'),
      ).toBe(false),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run · 60 points' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      tool: 'upscale',
      params: { mode: 'creative', prompt: 'A red lighthouse' },
    });
  });

  it('needs an outpaint side, shows the new size, and sends the sides', async () => {
    stubFetch();
    renderTools();
    const dialog = openTool('Outpaint');
    const run = within(dialog).getByRole('button', { name: 'Run · 6 points' });
    expect(run.hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('right'), { target: { value: '300' } });
    fireEvent.change(within(dialog).getByLabelText('up'), { target: { value: '5000' } });
    expect(within(dialog).getByText('New size: 1300 × 2500')).toBeTruthy();
    await waitFor(() => expect(run.hasAttribute('disabled')).toBe(false));
    fireEvent.click(run);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      tool: 'outpaint',
      params: { left: 0, right: 300, up: 2000, down: 0, prompt: 'A lighthouse at dusk' },
    });
  });

  it('needs a painted mask to erase, then uploads it and sends its key', async () => {
    stubFetch();
    const blob = new Blob(['mask'], { type: 'image/png' });
    const renderMask = vi.fn(async () => blob);
    const uploadClient: UploadClient = {
      start: vi.fn(async () => ({
        uploadId: '01JMMMMMMMMMMMMMMMMMMMMMMM',
        key: 'uploads/user/01JMMMMMMMMMMMMMMMMMMMMMMM',
        url: 'https://bucket.example',
        fields: {},
      })),
      send: vi.fn(async () => undefined),
      complete: vi.fn(),
    };
    renderTools({ renderMask, uploadClient });
    const dialog = openTool('Erase object');
    const run = within(dialog).getByRole('button', { name: 'Run · 7 points' });
    expect(run.hasAttribute('disabled')).toBe(true);

    const canvas = within(dialog).getByRole('img', { name: /^Erase mask/ });
    stubCanvasLayout(canvas);
    paint(canvas, [100, 100], [150, 120]);
    await waitFor(() => expect(run.hasAttribute('disabled')).toBe(false));
    fireEvent.click(run);

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(renderMask).toHaveBeenCalledWith(
      [expect.objectContaining({ points: expect.any(Array) })],
      expect.objectContaining({ width: 1000, height: 500 }),
    );
    const [file] = vi.mocked(uploadClient.start).mock.calls[0]!;
    expect(file).toMatchObject({ name: 'mask.png', type: 'image/png' });
    expect(uploadClient.send).toHaveBeenCalled();
    expect(posted[0]).toEqual({
      type: 'tool',
      imageId: IMAGE_ID,
      version: 2,
      tool: 'erase',
      params: { maskKey: 'uploads/user/01JMMMMMMMMMMMMMMMMMMMMMMM' },
    });
  });

  it('shows why a tool could not start, and why a run failed', async () => {
    stubFetch({
      create: { status: 400, body: { error: 'This image is too small for Remove background.' } },
    });
    renderTools();
    let dialog = openTool('Remove background');
    await waitFor(() =>
      expect(
        within(dialog).getByRole('button', { name: 'Run · 7 points' }).hasAttribute('disabled'),
      ).toBe(false),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run · 7 points' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'This image is too small for Remove background.',
    );

    cleanup();
    stubFetch();
    jobAnswers = [
      {
        status: 200,
        body: { jobId: JOB_ID, status: 'failed', error: 'The image model ran into a problem.' },
      },
    ];
    renderTools();
    dialog = openTool('Remove background');
    await waitFor(() =>
      expect(
        within(dialog).getByRole('button', { name: 'Run · 7 points' }).hasAttribute('disabled'),
      ).toBe(false),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run · 7 points' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'The image model ran into a problem.',
    );
  });

  it('turns the tools off while the platform spend cap pauses them', async () => {
    stubFetch();
    renderTools({ catalog: { ...catalog, pausedUntil: '2026-11-01T00:00:00.000Z' } });
    const dialog = openTool('Remove background');
    expect(
      within(dialog).getByText(
        "Image tools are paused until 1 November because this month's budget is used up.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole('button', { name: 'Run · 7 points' }).hasAttribute('disabled'),
    ).toBe(true);
  });
});
