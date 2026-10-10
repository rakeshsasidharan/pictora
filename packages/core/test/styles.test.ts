import { describe, expect, it } from 'vitest';
import {
  STYLE_IDS,
  STYLE_PRESETS,
  applyStyle,
  isStyleId,
  loadSeedRegistry,
  modelsForEnvironment,
  stylePreset,
  suggestedModelId,
} from '../src/index.js';

describe('style presets', () => {
  it('lists the GEN-2 presets in order', () => {
    expect(STYLE_PRESETS.map((preset) => preset.name)).toEqual([
      'Photorealistic',
      'Cinematic',
      'Digital art',
      'Anime',
      'Watercolour',
      'Oil painting',
      '3D render',
      'Line art',
      'None',
    ]);
    expect(STYLE_PRESETS.map((preset) => preset.id)).toEqual([...STYLE_IDS]);
  });

  it('gives every preset except None its style text', () => {
    for (const preset of STYLE_PRESETS) {
      if (preset.id === 'none') expect(preset.styleText).toBe('');
      else expect(preset.styleText.length).toBeGreaterThan(20);
    }
  });

  it('appends the style text to the prompt', () => {
    expect(applyStyle('  A fox in the snow.  ', 'watercolour')).toBe(
      `A fox in the snow. Style: ${stylePreset('watercolour').styleText}.`,
    );
  });

  it('leaves the prompt unchanged for None, apart from trimming', () => {
    expect(applyStyle(' A fox ', 'none')).toBe('A fox');
  });

  it('recognises style ids', () => {
    expect(isStyleId('anime')).toBe(true);
    expect(isStyleId('pixel-art')).toBe(false);
  });

  it('suggests a model for every style in each environment, from the registry defaults', () => {
    const models = loadSeedRegistry();
    for (const environment of ['dev', 'prod'] as const) {
      const available = modelsForEnvironment(models, environment);
      for (const style of STYLE_IDS) {
        expect(suggestedModelId(style, available)).toBeDefined();
      }
    }
    expect(suggestedModelId('photorealistic', models)).toBe('gemini-3-pro-image');
    expect(suggestedModelId('watercolour', models)).toBe('gemini-3.1-flash-image');
    expect(suggestedModelId('none', models)).toBe('gpt-image-2');
  });

  it('suggests nothing when no model is the default', () => {
    expect(suggestedModelId('anime', [{ id: 'x', defaultFor: [] }])).toBeUndefined();
  });
});
