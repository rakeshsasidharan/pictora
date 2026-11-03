import {
  ASPECTS,
  loadSeedRegistry,
  modelsForEnvironment,
  type GenerateDefaults,
} from '@pictora/core';
import { describe, expect, it } from 'vitest';
import {
  ASPECT_SHAPES,
  MAX_ALT_TEXT_LENGTH,
  altTextFor,
  choicesForModel,
  qualityPaused,
  costPerImage,
  generateModels,
  initialForm,
  modelCostSummary,
  modelForStyle,
  requestCost,
} from '../src/lib/generate_options';
import { attachment } from '../src/lib/images_bucket';
import { modelsResponse, type PublicModel } from '../src/lib/models_response';

const { models, styles } = modelsResponse(modelsForEnvironment(loadSeedRegistry(), 'dev'));

function model(id: string): PublicModel {
  const found = models.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`No model ${id}`);
  return found;
}

describe('generate options', () => {
  it('offers only models that can create new images', () => {
    const editOnly = { ...model('mock'), id: 'edit-only' };
    editOnly.capabilities = { ...editOnly.capabilities, generate: false };
    expect(generateModels([model('mock'), editOnly]).map((m) => m.id)).toEqual(['mock']);
  });

  it('picks the model a style suggests, or the first model when it suggests none available', () => {
    expect(modelForStyle('photorealistic', styles, models)?.id).toBe('gemini-3-pro-image');
    expect(modelForStyle('none', styles, models)?.id).toBe('gpt-image-2');
    const withoutGemini = models.filter((m) => m.provider !== 'gemini');
    expect(modelForStyle('photorealistic', styles, withoutGemini)?.id).toBe(withoutGemini[0]?.id);
    expect(modelForStyle('none', styles, [])).toBeUndefined();
  });

  it('keeps the quality and aspect a new model offers, and falls back otherwise', () => {
    expect(choicesForModel(model('gpt-image-2'), { quality: 'high', aspect: '16:9' })).toEqual({
      modelId: 'gpt-image-2',
      quality: 'high',
      aspect: '16:9',
    });
    // Gemini 3 Pro has no draft: Standard is preferred.
    expect(
      choicesForModel(model('gemini-3-pro-image'), { quality: 'draft', aspect: '1:1' }).quality,
    ).toBe('standard');
    // GPT Image 1 Mini only has draft.
    expect(
      choicesForModel(model('gpt-image-1-mini'), { quality: 'high', aspect: '1:1' }).quality,
    ).toBe('draft');
    const square = { ...model('mock') };
    square.capabilities = { ...square.capabilities, aspects: ['1:1'] };
    expect(choicesForModel(square, { quality: 'draft', aspect: '9:16' }).aspect).toBe('1:1');
  });

  it('skips paused qualities while another is offered', () => {
    const paused = { ...model('gpt-image-2') };
    paused.qualities = paused.qualities.map((option) =>
      option.quality === 'draft' ? option : { ...option, paused: true as const },
    );
    expect(choicesForModel(paused, { quality: 'high', aspect: '1:1' }).quality).toBe('draft');
    expect(qualityPaused(paused, 'high')).toBe(true);
    expect(qualityPaused(paused, 'draft')).toBe(false);
  });

  it('prices a request as the cost per image times the count', () => {
    expect(costPerImage(model('gpt-image-2'), 'high')).toBe(22);
    expect(costPerImage(model('gemini-3-pro-image'), 'draft')).toBeUndefined();
    expect(requestCost(model('gpt-image-2'), 'standard', 3)).toBe(18);
    expect(requestCost(model('mock'), 'draft', 2)).toBe(2);
  });

  it('summarises a model’s costs for the picker', () => {
    expect(modelCostSummary(model('gpt-image-2'))).toBe(
      'Draft 1 · Standard 6 · High 22 points per image',
    );
    expect(modelCostSummary(model('gpt-image-1-mini'))).toBe('Draft 1 point per image');
  });

  it('draws every aspect as a shape with its own ratio', () => {
    expect(Object.keys(ASPECT_SHAPES)).toEqual([...ASPECTS]);
    expect(ASPECT_SHAPES['16:9']).toContain('aspect-video');
    expect(new Set(Object.values(ASPECT_SHAPES)).size).toBe(ASPECTS.length);
  });

  it('uses the prompt, trimmed to 150 characters, as alt text', () => {
    expect(altTextFor('  A red   fox \n in snow ')).toBe('A red fox in snow');
    const long = altTextFor('word '.repeat(60));
    expect(long.length).toBeLessThanOrEqual(MAX_ALT_TEXT_LENGTH);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('attachment', () => {
  it('saves under the file name, keeping only safe characters', () => {
    expect(attachment('pictora-01J-v1.png')).toBe('attachment; filename="pictora-01J-v1.png"');
    expect(attachment('a"b;c.png')).toBe('attachment; filename="a_b_c.png"');
  });
});

describe('initialForm', () => {
  const available = generateModels(models);

  it('starts empty, from the app defaults: None, Auto, the enhancer on', () => {
    expect(initialForm(styles, available)).toEqual({
      prompt: '',
      avoid: '',
      styleId: 'none',
      choices: choicesForModel(modelForStyle('none', styles, available)!, {
        quality: 'standard',
        aspect: '1:1',
      }),
      auto: true,
      count: 1,
      transparent: false,
      later: false,
      enhance: true,
      modelReplaced: false,
      defaultModelMissing: false,
    });
  });

  const saved: GenerateDefaults = {
    style: 'anime',
    modelId: 'mock',
    aspect: '16:9',
    quality: 'high',
    count: 3,
    transparentBackground: true,
    deliverLater: true,
    avoid: 'blur',
    enhance: false,
  };

  it("starts from the user's saved defaults (GEN-11)", () => {
    expect(initialForm(styles, available, undefined, saved)).toEqual({
      prompt: '',
      avoid: 'blur',
      styleId: 'anime',
      choices: { modelId: 'mock', quality: 'high', aspect: '16:9' },
      auto: false,
      count: 3,
      transparent: true,
      later: true,
      enhance: false,
      modelReplaced: false,
      defaultModelMissing: false,
    });
  });

  it('falls back to what the saved model offers', () => {
    // GPT Image 1 Mini has only draft, no negative prompt; Gemini has no transparency.
    const mini = initialForm(styles, available, undefined, {
      ...saved,
      modelId: 'gpt-image-1-mini',
    });
    expect(mini.choices).toEqual({ modelId: 'gpt-image-1-mini', quality: 'draft', aspect: '16:9' });
    expect(mini.avoid).toBe('');
    expect(mini.transparent).toBe(true);
    const gemini = initialForm(styles, available, undefined, {
      ...saved,
      modelId: 'gemini-3.1-flash-image',
    });
    expect(gemini.transparent).toBe(false);
    expect(gemini.later).toBe(true);
    const stability = initialForm(styles, available, undefined, {
      ...saved,
      modelId: 'sd3.5-large',
    });
    expect(stability.later).toBe(false);
    expect(stability.avoid).toBe('blur');
  });

  it('keeps the saved options any model offers with Auto', () => {
    const form = initialForm(styles, available, undefined, { ...saved, modelId: 'auto' });
    expect(form.auto).toBe(true);
    expect(form.choices).toMatchObject({ quality: 'high', aspect: '16:9' });
    expect(form).toMatchObject({ avoid: 'blur', transparent: true, later: true });
    expect(form.defaultModelMissing).toBe(false);
  });

  it('drops a saved quality that is paused by the spend cap', () => {
    const paused = available.map((candidate) => ({
      ...candidate,
      qualities: candidate.qualities.map((option) =>
        option.quality === 'draft' ? option : { ...option, paused: true as const },
      ),
    }));
    expect(
      initialForm(styles, paused, undefined, { ...saved, modelId: 'auto' }).choices?.quality,
    ).toBe('draft');
    expect(initialForm(styles, paused, undefined, saved).choices?.quality).toBe('draft');
  });

  it('goes to Auto, and says so, when the saved model is gone', () => {
    const form = initialForm(styles, available, undefined, { ...saved, modelId: 'retired' });
    expect(form.auto).toBe(true);
    expect(form.defaultModelMissing).toBe(true);
    expect(form.styleId).toBe('anime');
    expect(form.count).toBe(3);
  });

  it("takes a rerun's own settings, and only the count and Save points from the defaults", () => {
    const form = initialForm(
      styles,
      available,
      { prompt: 'A fox', style: 'none', modelId: 'gpt-image-2', quality: 'draft', aspect: '1:1' },
      saved,
    );
    expect(form).toMatchObject({
      styleId: 'none',
      choices: { modelId: 'gpt-image-2', quality: 'draft', aspect: '1:1' },
      auto: false,
      count: 3,
      later: true,
      transparent: false,
      enhance: false,
    });
  });

  it("keeps a rerun's settings and seed with the original model", () => {
    expect(
      initialForm(styles, available, {
        prompt: 'A fox',
        enhancedPrompt: 'A red fox',
        avoid: 'blur',
        style: 'anime',
        modelId: 'mock',
        quality: 'draft',
        aspect: '9:16',
        seed: 5,
        transparentBackground: true,
      }),
    ).toEqual({
      prompt: 'A fox',
      avoid: 'blur',
      styleId: 'anime',
      choices: { modelId: 'mock', quality: 'draft', aspect: '9:16' },
      auto: false,
      count: 1,
      transparent: true,
      later: false,
      enhance: true,
      seed: 5,
      enhancedPrompt: 'A red fox',
      modelReplaced: false,
      defaultModelMissing: false,
    });
  });

  it('drops options the model does not take', () => {
    const form = initialForm(styles, available, {
      prompt: 'A fox',
      avoid: 'blur',
      modelId: 'gpt-image-2',
      seed: 5,
      transparentBackground: true,
    });
    const gpt = model('gpt-image-2');
    expect(form.avoid).toBe(gpt.capabilities.negativePrompt ? 'blur' : '');
    expect(form.transparent).toBe(gpt.capabilities.transparentBackground);
    expect('seed' in form).toBe(gpt.capabilities.seed);
  });

  it("picks the style's model, without the seed, when the original is gone", () => {
    const form = initialForm(styles, available, {
      prompt: 'A fox',
      style: 'none',
      modelId: 'retired',
      seed: 5,
    });
    expect(form.modelReplaced).toBe(true);
    expect(form.choices?.modelId).toBe(modelForStyle('none', styles, available)?.id);
    expect(form).not.toHaveProperty('seed');
  });
});
