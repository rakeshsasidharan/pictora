import { describe, expect, it } from 'vitest';
import {
  TESTERS_GROUP,
  TOOL_IDS,
  createJobRequestSchema,
  fitToolInput,
  isToolOnlyModel,
  loadSeedRegistry,
  pickToolModel,
  toolCostPoints,
  toolIdFor,
  toolJobRequestSchema,
  toolTakesPrompt,
} from '../src/index.js';

const IMAGE_ID = '01JABCDEFGHJKMNPQRSTVWXYZ0';
const MASK_KEY = 'uploads/user-1/01JABCDEFGHJKMNPQRSTVWXYZ1';

const models = loadSeedRegistry();

describe('tool registry', () => {
  it('has a Bedrock model for every tool, and the Mock runs them all on dev', () => {
    for (const toolId of TOOL_IDS) {
      const runners = models.filter((model) => toolCostPoints(model, toolId) !== undefined);
      expect(runners.map((model) => model.provider).sort()).toEqual(['bedrock', 'mock']);
    }
  });

  it('prices each tool from the Bedrock list price, one point a cent', () => {
    const prices = Object.fromEntries(
      TOOL_IDS.map((toolId) => [
        toolId,
        toolCostPoints(pickToolModel(models, toolId, [])!, toolId),
      ]),
    );
    expect(prices).toEqual({
      'upscale-fast': 3,
      'upscale-conservative': 40,
      'upscale-creative': 60,
      'remove-background': 7,
      erase: 7,
      outpaint: 6,
    });
  });

  it('marks the Stability tool models as tool only', () => {
    expect(models.filter(isToolOnlyModel).map((model) => model.id)).toEqual([
      'stable-fast-upscale',
      'stable-conservative-upscale',
      'stable-creative-upscale',
      'stable-image-remove-background',
      'stable-image-erase-object',
      'stable-outpaint',
    ]);
  });
});

describe('pickToolModel', () => {
  it('picks the Bedrock model for everyone outside the testers group', () => {
    expect(pickToolModel(models, 'erase', [])?.id).toBe('stable-image-erase-object');
    expect(pickToolModel(models, 'upscale-fast', ['admins'])?.id).toBe('stable-fast-upscale');
  });

  it('picks the Mock for the testers group, so end-to-end runs cost nothing', () => {
    expect(pickToolModel(models, 'upscale-fast', [TESTERS_GROUP])?.id).toBe('mock');
  });

  it('falls back to the Bedrock model for testers when the Mock is not offered', () => {
    const real = models.filter((model) => model.provider !== 'mock');
    expect(pickToolModel(real, 'outpaint', [TESTERS_GROUP])?.id).toBe('stable-outpaint');
  });

  it('finds nothing when no model runs the tool', () => {
    const generators = models.filter((model) => !model.tools);
    expect(pickToolModel(generators, 'outpaint', [])).toBeUndefined();
  });
});

describe('toolIdFor and toolTakesPrompt', () => {
  it('names an upscale by its mode, and other tools by themselves', () => {
    expect(toolIdFor({ tool: 'upscale', params: { mode: 'creative' } })).toBe('upscale-creative');
    expect(toolIdFor({ tool: 'erase', params: { maskKey: MASK_KEY } })).toBe('erase');
  });

  it('takes a prompt for the conservative and creative upscales and for outpaint only', () => {
    expect(TOOL_IDS.filter(toolTakesPrompt)).toEqual([
      'upscale-conservative',
      'upscale-creative',
      'outpaint',
    ]);
  });
});

describe('fitToolInput', () => {
  it('keeps a 1024 px square as it is', () => {
    expect(fitToolInput('upscale-fast', { width: 1024, height: 1024 })).toEqual({
      ok: true,
      size: { width: 1024, height: 1024 },
    });
  });

  it('scales an image down to the fast upscaler’s megapixel and longest side', () => {
    const fit = fitToolInput('upscale-fast', { width: 4096, height: 2048 });
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    expect(fit.size.width).toBeLessThanOrEqual(1448);
    expect(fit.size.width * fit.size.height).toBeLessThanOrEqual(1_048_576);
    expect(fit.size.width / fit.size.height).toBeCloseTo(2, 2);
  });

  it('scales down for the creative upscaler’s one megapixel, but leaves a 4K image for conservative', () => {
    const fit = fitToolInput('upscale-creative', { width: 2048, height: 2048 });
    expect(fit).toEqual({ ok: true, size: { width: 1024, height: 1024 } });
    expect(fitToolInput('upscale-conservative', { width: 2048, height: 2048 })).toEqual({
      ok: true,
      size: { width: 2048, height: 2048 },
    });
  });

  it('never scales up', () => {
    expect(fitToolInput('erase', { width: 300, height: 200 })).toEqual({
      ok: true,
      size: { width: 300, height: 200 },
    });
  });

  it('refuses an image that is too small, in words for the user', () => {
    expect(fitToolInput('remove-background', { width: 63, height: 100 })).toEqual({
      ok: false,
      problem:
        'This image is too small for Remove background. Pick a larger version or another tool.',
    });
    expect(fitToolInput('upscale-creative', { width: 64, height: 63 }).ok).toBe(false);
  });

  it('refuses an image wider than 2.5 to 1 for the tools with that limit', () => {
    const fit = fitToolInput('outpaint', { width: 2600, height: 1000 });
    expect(fit).toEqual({
      ok: false,
      problem:
        'Outpaint works on images no wider or taller than 2.5 to 1. Pick another version or tool.',
    });
    expect(fitToolInput('upscale-fast', { width: 1300, height: 500 }).ok).toBe(true);
  });
});

describe('toolJobRequestSchema', () => {
  const base = { type: 'tool', imageId: IMAGE_ID, version: 2 } as const;

  it('accepts each tool with its parameters through the job request schema', () => {
    for (const request of [
      { ...base, tool: 'upscale', params: { mode: 'fast' } },
      { ...base, tool: 'upscale', params: { mode: 'creative', prompt: 'A red fox' } },
      { ...base, tool: 'remove-background', params: {} },
      { ...base, tool: 'erase', params: { maskKey: MASK_KEY, growMask: 5 } },
      { ...base, tool: 'outpaint', params: { left: 0, right: 256, up: 0, down: 0 } },
    ]) {
      expect(createJobRequestSchema.safeParse(request).success).toBe(true);
    }
  });

  it('refuses an unknown upscale mode, and parameters of another tool', () => {
    expect(
      toolJobRequestSchema.safeParse({ ...base, tool: 'upscale', params: { mode: 'huge' } })
        .success,
    ).toBe(false);
    expect(
      toolJobRequestSchema.safeParse({
        ...base,
        tool: 'remove-background',
        params: { mode: 'fast' },
      }).success,
    ).toBe(false);
  });

  it('takes an erase mask only as an upload key', () => {
    const versionKey = `users/user-1/${IMAGE_ID}/v1.png`;
    expect(
      toolJobRequestSchema.safeParse({ ...base, tool: 'erase', params: { maskKey: versionKey } })
        .success,
    ).toBe(false);
    expect(
      toolJobRequestSchema.safeParse({
        ...base,
        tool: 'erase',
        params: { maskKey: MASK_KEY, growMask: 21 },
      }).success,
    ).toBe(false);
  });

  it('needs an outpaint to extend in at least one direction, by at most 2,000 px', () => {
    const outpaint = (sides: Record<string, number>) =>
      toolJobRequestSchema.safeParse({
        ...base,
        tool: 'outpaint',
        params: { left: 0, right: 0, up: 0, down: 0, ...sides },
      }).success;
    expect(outpaint({})).toBe(false);
    expect(outpaint({ up: 2000 })).toBe(true);
    expect(outpaint({ up: 2001 })).toBe(false);
    expect(outpaint({ left: -1, right: 10 })).toBe(false);
  });

  it('refuses a version below 1 and unknown fields', () => {
    expect(
      toolJobRequestSchema.safeParse({ ...base, version: 0, tool: 'remove-background', params: {} })
        .success,
    ).toBe(false);
    expect(
      toolJobRequestSchema.safeParse({
        ...base,
        tool: 'remove-background',
        params: {},
        modelId: 'mock',
      }).success,
    ).toBe(false);
  });
});
