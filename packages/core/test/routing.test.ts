import { describe, expect, it } from 'vitest';
import {
  STYLE_FALLBACKS,
  TEXT_MODELS,
  loadSeedRegistry,
  modelsForEnvironment,
  promptAsksForText,
  routeModel,
  STYLE_IDS,
  type ModelConfig,
  type Quality,
  type RouteRequest,
  type StyleId,
} from '../src/index.js';

// Prod's registry: no mock model, so the cheapest real models are in play.
const prod = modelsForEnvironment(loadSeedRegistry(), 'prod');
const without = (...ids: string[]) => prod.filter((model) => !ids.includes(model.id));
const dev = modelsForEnvironment(loadSeedRegistry(), 'dev');

function route(overrides: Partial<RouteRequest> = {}) {
  return routeModel({
    style: 'none',
    quality: 'standard',
    aspect: '1:1',
    pointsLeft: 25,
    models: prod,
    ...overrides,
  });
}

describe('routeModel', () => {
  const cases: {
    name: string;
    request: Partial<RouteRequest>;
    expected: { modelId: string; quality: Quality; reason: string; points?: number };
  }[] = [
    {
      name: 'picks the default model for each style',
      request: { style: 'watercolour' },
      expected: { modelId: 'gemini-3.1-flash-image', quality: 'standard', reason: 'style-default' },
    },
    {
      name: 'picks the photorealistic default',
      request: { style: 'photorealistic' },
      expected: {
        modelId: 'gemini-3-pro-image',
        quality: 'standard',
        reason: 'style-default',
        points: 14,
      },
    },
    {
      name: 'picks the default for no style',
      request: { style: 'none', quality: 'high' },
      expected: { modelId: 'gpt-image-2', quality: 'high', reason: 'style-default', points: 22 },
    },
    {
      name: 'falls back through the style table when the default is switched off',
      request: { style: 'photorealistic', quality: 'high', models: without('gemini-3-pro-image') },
      expected: { modelId: 'stable-image-ultra', quality: 'high', reason: 'fallback' },
    },
    {
      name: 'skips a fallback that lacks the quality',
      request: { style: 'photorealistic', models: without('gemini-3-pro-image') },
      expected: { modelId: 'gpt-image-2', quality: 'standard', reason: 'fallback' },
    },
    {
      name: 'needs a transparent background',
      request: { style: 'watercolour', needs: { transparentBackground: true } },
      expected: { modelId: 'gpt-image-2', quality: 'standard', reason: 'fallback' },
    },
    {
      name: 'prefers a text model when the prompt asks for words',
      request: { style: 'watercolour', needs: { text: true } },
      expected: { modelId: 'gpt-image-2', quality: 'standard', reason: 'text' },
    },
    {
      name: 'uses the style default when the text model is switched off',
      request: { style: 'watercolour', needs: { text: true }, models: without('gpt-image-2') },
      expected: { modelId: 'gemini-3.1-flash-image', quality: 'standard', reason: 'style-default' },
    },
    {
      name: 'routes edits to models that edit',
      request: { style: 'photorealistic', needs: { edit: true } },
      expected: { modelId: 'gemini-3-pro-image', quality: 'standard', reason: 'style-default' },
    },
    {
      name: 'takes the best affordable model at the same quality when points are low',
      request: { style: 'photorealistic', pointsLeft: 10 },
      expected: { modelId: 'gpt-image-2', quality: 'standard', reason: 'affordable', points: 6 },
    },
    {
      name: 'counts every image requested',
      request: { style: 'photorealistic', pointsLeft: 20, count: 2 },
      expected: {
        modelId: 'gpt-image-2',
        quality: 'standard',
        reason: 'affordable',
        points: 12,
      },
    },
    {
      name: 'drops to a lower quality when nothing fits at the one asked for',
      request: { style: 'photorealistic', pointsLeft: 5 },
      expected: { modelId: 'gpt-image-2', quality: 'draft', reason: 'lower-quality', points: 1 },
    },
    {
      name: 'drops two qualities when it must',
      request: { style: 'cinematic', quality: 'high', pointsLeft: 3 },
      expected: { modelId: 'gpt-image-2', quality: 'draft', reason: 'lower-quality' },
    },
    {
      name: 'returns the first choice when nothing fits at all',
      request: { style: 'anime', pointsLeft: 0 },
      expected: {
        modelId: 'gemini-3.1-flash-image',
        quality: 'standard',
        reason: 'unaffordable',
        points: 7,
      },
    },
    {
      name: 'skips paused qualities during a premium pause',
      request: { style: 'anime', pausedQualities: ['standard', 'high'] },
      expected: { modelId: 'gpt-image-2', quality: 'draft', reason: 'fallback' },
    },
    {
      name: 'falls back to the next quality a paused default still has',
      request: { style: 'none', pausedQualities: ['standard', 'high'] },
      expected: { modelId: 'gpt-image-2', quality: 'draft', reason: 'style-default', points: 1 },
    },
    {
      name: 'goes up a quality when nothing offers a lower one',
      request: {
        style: 'none',
        quality: 'draft',
        models: prod.filter((model) => model.id === 'gemini-3-pro-image'),
      },
      expected: { modelId: 'gemini-3-pro-image', quality: 'standard', reason: 'fallback' },
    },
  ];

  it.each(cases)('$name', ({ request, expected }) => {
    expect(route(request)).toMatchObject(expected);
  });

  it('leaves the mock model for last in dev', () => {
    const onlyCheap = dev.filter((model) =>
      ['mock', 'gpt-image-1-mini', 'gemini-3.1-flash-lite-image'].includes(model.id),
    );
    expect(route({ quality: 'draft', models: onlyCheap })?.modelId).not.toBe('mock');
    expect(route({ models: dev.filter((model) => model.id === 'mock') })?.modelId).toBe('mock');
  });

  it('finds nothing when no model can make the image', () => {
    const opaque = prod.filter((model) => !model.capabilities.transparentBackground);
    expect(route({ needs: { transparentBackground: true }, models: opaque })).toBeUndefined();
    expect(route({ models: [] })).toBeUndefined();
  });

  it('skips a model that lacks the aspect while another has it', () => {
    const square: ModelConfig[] = prod.map((model) =>
      model.id === 'gemini-3.1-flash-image'
        ? { ...model, capabilities: { ...model.capabilities, aspects: ['1:1'] } }
        : model,
    );
    expect(route({ style: 'anime', aspect: '16:9', models: square })?.modelId).not.toBe(
      'gemini-3.1-flash-image',
    );
    expect(route({ style: 'anime', aspect: '1:1', models: square })?.modelId).toBe(
      'gemini-3.1-flash-image',
    );
  });

  it('always finds an affordable route in prod for every style and quality', () => {
    for (const style of STYLE_IDS) {
      for (const quality of ['draft', 'standard', 'high'] as const) {
        const result = route({ style: style as StyleId, quality, pointsLeft: 25 });
        expect(result, `${style} at ${quality}`).toBeDefined();
        expect(result!.points).toBeLessThanOrEqual(25);
      }
    }
  });

  it('names only models in the registry in its tables', () => {
    const ids = new Set(loadSeedRegistry().map((model) => model.id));
    for (const id of [...TEXT_MODELS, ...Object.values(STYLE_FALLBACKS).flat()]) {
      expect(ids.has(id), id).toBe(true);
    }
  });
});

describe('promptAsksForText', () => {
  it.each([
    'A poster that says "Summer Sale"',
    'A neon sign reading OPEN',
    'A birthday card with the words happy birthday',
    'Logo for a coffee shop called Bean There',
    'A book cover with the title The Long Road',
    'Hand lettering of a quote',
    'A cake saying Congrats',
    'Movie poster with headline in bold typography',
    'A shop front, the sign “Bakery”',
  ])('is true for %s', (prompt) => {
    expect(promptAsksForText(prompt)).toBe(true);
  });

  it.each([
    'A lighthouse at dusk',
    'A fox in the snow, cinematic lighting',
    'Portrait of an old sailor',
    'A quiet street sign-less and empty',
  ])('is false for %s', (prompt) => {
    expect(promptAsksForText(prompt)).toBe(false);
  });
});
