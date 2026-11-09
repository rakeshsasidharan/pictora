import { TESTERS_GROUP, loadSeedRegistry } from '@pictora/core';
import { describe, expect, it, vi } from 'vitest';
import { versionDescription } from '../src/lib/edit_options';
import { placeholderText, versionFields } from '../src/lib/gallery_format';
import { outpaintPixels, outpaintSize, toolJobRequest, upscaleModes } from '../src/lib/image_tools';
import type { ImageVersionBody } from '../src/lib/images';
import {
  MASK_UPLOAD_MAX_PX,
  brushPixels,
  drawStrokes,
  fitWithin,
  imagePoint,
  renderMaskPng,
  type MaskContext,
} from '../src/lib/mask';
import { toolsFor } from '../src/lib/tool_catalog';

const IMAGE_ID = '01JAAAAAAAAAAAAAAAAAAAAAAA';
const seed = loadSeedRegistry();

/** A 2D context that records the calls the mask makes. */
function recordingContext() {
  const calls: string[] = [];
  const context = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineCap: 'butt',
    lineJoin: 'miter',
    beginPath: () => calls.push('beginPath'),
    moveTo: (x: number, y: number) => calls.push(`moveTo ${x},${y}`),
    lineTo: (x: number, y: number) => calls.push(`lineTo ${x},${y}`),
    stroke: () => calls.push('stroke'),
    arc: (x: number, y: number, r: number) => calls.push(`arc ${x},${y} r${r}`),
    fill: () => calls.push('fill'),
    fillRect: (x: number, y: number, w: number, h: number) =>
      calls.push(`fillRect ${x},${y},${w},${h}`),
    clearRect: () => calls.push('clearRect'),
  };
  return { context: context as unknown as MaskContext & typeof context, calls };
}

describe('mask helpers', () => {
  it('sizes brushes as a share of the longer side, at least 2 px', () => {
    expect(brushPixels('small', { width: 1000, height: 500 })).toBe(20);
    expect(brushPixels('medium', { width: 500, height: 1000 })).toBe(50);
    expect(brushPixels('large', { width: 10, height: 10 })).toBe(2);
  });

  it('maps a pointer on the shown picture to image pixels, inside the image', () => {
    const rect = { left: 10, top: 20, width: 500, height: 250 };
    const image = { width: 2000, height: 1000 };
    expect(imagePoint({ clientX: 260, clientY: 145 }, rect, image)).toEqual({ x: 1000, y: 500 });
    expect(imagePoint({ clientX: -50, clientY: 900 }, rect, image)).toEqual({ x: 0, y: 1000 });
  });

  it('fits a size within a limit without enlarging it', () => {
    expect(fitWithin({ width: 4096, height: 2048 }, 2048)).toEqual({
      width: 2048,
      height: 1024,
      scale: 0.5,
    });
    expect(fitWithin({ width: 300, height: 200 }, 2048)).toEqual({
      width: 300,
      height: 200,
      scale: 1,
    });
  });

  it('draws a line for a stroke and a dot for a tap, scaled', () => {
    const { context, calls } = recordingContext();
    drawStrokes(
      context,
      [
        {
          size: 20,
          points: [
            { x: 10, y: 10 },
            { x: 30, y: 40 },
          ],
        },
        { size: 8, points: [{ x: 100, y: 50 }] },
      ],
      0.5,
      '#fff',
    );
    expect(calls).toEqual([
      'beginPath',
      'moveTo 5,5',
      'lineTo 15,20',
      'stroke',
      'beginPath',
      'arc 50,25 r2',
      'fill',
    ]);
    expect(context.lineCap).toBe('round');
    expect(context.lineWidth).toBe(10);
  });

  it('renders the mask as white strokes on black at most 2048 px, as a PNG', async () => {
    const { context, calls } = recordingContext();
    const blob = new Blob(['png'], { type: 'image/png' });
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
      toBlob: vi.fn((done: (blob: Blob | null) => void, type: string) => {
        expect(type).toBe('image/png');
        done(blob);
      }),
    };
    const result = await renderMaskPng(
      [{ size: 40, points: [{ x: 2000, y: 1000 }] }],
      { width: 4096, height: 2048 },
      () => canvas as unknown as HTMLCanvasElement,
    );
    expect(result).toBe(blob);
    expect([canvas.width, canvas.height]).toEqual([MASK_UPLOAD_MAX_PX, 1024]);
    expect(calls[0]).toBe('fillRect 0,0,2048,1024');
    expect(calls).toContain('arc 1000,500 r10');
    expect(context.fillStyle).toBe('#ffffff');
  });
});

describe('image tool requests', () => {
  it('keeps outpaint sides whole numbers from 0 to 2,000', () => {
    expect(outpaintPixels('120.7')).toBe(120);
    expect(outpaintPixels('-5')).toBe(0);
    expect(outpaintPixels('')).toBe(0);
    expect(outpaintPixels('abc')).toBe(0);
    expect(outpaintPixels('9999')).toBe(2000);
    expect(
      outpaintSize({ width: 100, height: 50 }, { left: 10, right: 20, up: 0, down: 5 }),
    ).toEqual({ width: 130, height: 55 });
  });

  it('builds the job body for each tool, leaving out empty and unused prompts', () => {
    expect(
      toolJobRequest(IMAGE_ID, 2, { tool: 'upscale', mode: 'fast', prompt: 'ignored' }),
    ).toEqual({
      type: 'tool',
      imageId: IMAGE_ID,
      version: 2,
      tool: 'upscale',
      params: { mode: 'fast' },
    });
    expect(
      toolJobRequest(IMAGE_ID, 2, { tool: 'upscale', mode: 'conservative', prompt: ' Fox ' }),
    ).toMatchObject({ params: { mode: 'conservative', prompt: 'Fox' } });
    expect(toolJobRequest(IMAGE_ID, 1, { tool: 'remove-background' })).toMatchObject({
      tool: 'remove-background',
      params: {},
    });
    expect(
      toolJobRequest(IMAGE_ID, 1, {
        tool: 'outpaint',
        sides: { left: 1, right: 0, up: 0, down: 0 },
        prompt: '  ',
      }).params,
    ).toEqual({ left: 1, right: 0, up: 0, down: 0 });
  });
});

describe('toolsFor', () => {
  it('prices each tool on its Bedrock model for everyone outside the testers group', () => {
    expect(toolsFor(seed, [], () => true)).toEqual({
      tools: [
        { id: 'upscale-fast', name: 'Fast upscale', costPoints: 3 },
        { id: 'upscale-conservative', name: 'Conservative upscale', costPoints: 40 },
        { id: 'upscale-creative', name: 'Creative upscale', costPoints: 60 },
        { id: 'remove-background', name: 'Remove background', costPoints: 7 },
        { id: 'erase', name: 'Erase object', costPoints: 7 },
        { id: 'outpaint', name: 'Outpaint', costPoints: 6 },
      ],
    });
  });

  it('prices them on the Mock for the testers group', () => {
    const { tools } = toolsFor(seed, [TESTERS_GROUP], () => true);
    expect(tools.every((tool) => tool.costPoints === 1)).toBe(true);
  });

  it('leaves out switched-off tools and those without a queue, and carries a pause', () => {
    const models = seed.map((model) =>
      model.id === 'stable-creative-upscale' ? { ...model, enabled: false } : model,
    );
    const catalog = toolsFor(models, [], () => true, {
      until: new Date('2026-11-01T00:00:00.000Z'),
    } as never);
    expect(upscaleModes(catalog.tools)).toEqual(['fast', 'conservative']);
    expect(catalog.pausedUntil).toBe('2026-11-01T00:00:00.000Z');
    expect(toolsFor(seed, [], (provider) => provider !== 'bedrock').tools).toEqual([]);
  });
});

describe('tool versions in the image views', () => {
  const version: ImageVersionBody = {
    version: 3,
    parentVersion: 1,
    tool: 'upscale-creative',
    toolPrompt: 'A fox in snow',
    modelId: 'stable-creative-upscale',
    width: 4096,
    height: 4096,
    url: 'u',
    downloadUrl: 'd',
    thumbUrl: 't',
  };

  it('names the tool, its prompt and the version it was made from', () => {
    const fields = versionFields(version, { 'stable-creative-upscale': 'Stable Creative Upscale' });
    expect(fields.slice(0, 4)).toEqual([
      { label: 'Tool', value: 'Creative upscale' },
      { label: 'Tool prompt', value: 'A fox in snow', scroll: true },
      { label: 'Made from', value: 'Version 1' },
      { label: 'Model', value: 'Stable Creative Upscale' },
    ]);
  });

  it('describes a tool version in the version list and its default alt text', () => {
    expect(versionDescription(version)).toBe('Creative upscale of version 1: A fox in snow');
    expect(
      versionDescription({ ...version, tool: 'remove-background', toolPrompt: undefined }),
    ).toBe('Remove background of version 1');
  });

  it('shows a running tool job as Editing in the gallery', () => {
    expect(
      placeholderText({
        jobId: 'j',
        type: 'tool',
        status: 'running',
        createdAt: '2026-10-15T12:00:00.000Z',
        text: 'Outpaint',
        count: 1,
      }),
    ).toBe('Editing');
  });
});
