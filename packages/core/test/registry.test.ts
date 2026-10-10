import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  RegistryValidationError,
  findModel,
  isAspect,
  isQuality,
  loadSeedRegistry,
  modelsForEnvironment,
  parseRegistry,
  validateRegistry,
} from '../src/index.js';

const seed: unknown[] = JSON.parse(
  readFileSync(new URL('../models.json', import.meta.url), 'utf8'),
);

/** A deep copy of the seed, so each test can break it differently. */
function seedCopy(): Record<string, unknown>[] {
  return structuredClone(seed) as Record<string, unknown>[];
}

function entry(models: Record<string, unknown>[], id: string): Record<string, unknown> {
  const found = models.find((model) => model.id === id);
  if (!found) throw new Error(`Missing model ${id}`);
  return found;
}

describe('models.json', () => {
  it('is a valid registry', () => {
    expect(validateRegistry(seed).errors).toEqual([]);
  });

  it('holds the five P0 models and the dev-only mock', () => {
    const models = loadSeedRegistry();
    expect(models.map((model) => [model.id, model.provider, model.environments])).toEqual([
      ['gpt-image-2', 'openai', ['dev', 'prod']],
      ['gpt-image-1-mini', 'openai', ['dev', 'prod']],
      ['gemini-3.1-flash-image', 'gemini', ['dev', 'prod']],
      ['gemini-3.1-flash-lite-image', 'gemini', ['dev', 'prod']],
      ['gemini-3-pro-image', 'gemini', ['dev', 'prod']],
      ['mock', 'mock', ['dev']],
    ]);
  });

  it('offers transparent backgrounds only on OpenAI and the mock (GEN-9)', () => {
    const transparent = loadSeedRegistry()
      .filter((model) => model.capabilities.transparentBackground)
      .map((model) => model.id);
    expect(transparent).toEqual(['gpt-image-2', 'gpt-image-1-mini', 'mock']);
  });

  it('keeps a draft-quality model in prod for when the platform cap is reached', () => {
    const drafts = modelsForEnvironment(loadSeedRegistry(), 'prod').filter(
      (model) => model.qualities.draft,
    );
    expect(drafts.length).toBeGreaterThan(0);
  });
});

describe('validateRegistry', () => {
  it('rejects something that is not an array', () => {
    expect(validateRegistry({}).errors).toEqual(['The registry must be an array of models']);
  });

  it('reports duplicate ids', () => {
    const models = seedCopy();
    models.push(structuredClone(entry(models, 'gpt-image-1-mini')));
    expect(validateRegistry(models).errors).toContain('Duplicate model id: gpt-image-1-mini');
  });

  it('reports a quality without a cost', () => {
    const models = seedCopy();
    const qualities = entry(models, 'gemini-3-pro-image').qualities as Record<
      string,
      Record<string, unknown>
    >;
    delete qualities.high?.costPoints;
    // An entry that fails to parse is left out, so its styles also lose their default model.
    expect(validateRegistry(models).errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Model gemini-3-pro-image: qualities\.high\.costPoints: /),
      ]),
    );
  });

  it('reports a cost that is not a positive whole number', () => {
    const models = seedCopy();
    const qualities = entry(models, 'gpt-image-1-mini').qualities as Record<
      string,
      Record<string, unknown>
    >;
    (qualities.draft as Record<string, unknown>).costPoints = 0.5;
    expect(validateRegistry(models).errors).toEqual([
      expect.stringMatching(/^Model gpt-image-1-mini: qualities\.draft\.costPoints: /),
    ]);
  });

  it('reports a model with no qualities', () => {
    const models = seedCopy();
    entry(models, 'gpt-image-1-mini').qualities = {};
    expect(validateRegistry(models).errors).toEqual([
      'Model gpt-image-1-mini: has no qualities with a cost',
    ]);
  });

  it('reports an unknown provider, quality or aspect', () => {
    const models = seedCopy();
    entry(models, 'gpt-image-2').provider = 'midjourney';
    entry(models, 'gpt-image-1-mini').qualities = { ultra: { providerParams: {}, costPoints: 1 } };
    const mock = entry(models, 'mock');
    mock.capabilities = { ...(mock.capabilities as object), aspects: ['1:1', '21:9'] };
    const errors = validateRegistry(models).errors;
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Model gpt-image-2: provider: /),
        expect.stringMatching(/^Model gpt-image-1-mini: qualities: .*ultra/),
        expect.stringMatching(/^Model mock: capabilities\.aspects\.1: /),
      ]),
    );
  });

  it('reports a model with no aspects listed', () => {
    const models = seedCopy();
    const mock = entry(models, 'mock');
    mock.capabilities = { ...(mock.capabilities as object), aspects: [] };
    expect(validateRegistry(models).errors).toEqual([
      expect.stringMatching(/^Model mock: capabilities\.aspects: /),
    ]);
  });

  it('reports an aspect listed twice', () => {
    const models = seedCopy();
    const mock = entry(models, 'mock');
    mock.capabilities = { ...(mock.capabilities as object), aspects: ['1:1', '1:1'] };
    expect(validateRegistry(models).errors).toEqual(['Model mock: lists an aspect more than once']);
  });

  it('reports an aspect the provider cannot size', () => {
    const models = seedCopy();
    const qualities = entry(models, 'gemini-3-pro-image').qualities as Record<
      string,
      Record<string, unknown>
    >;
    (qualities.high as Record<string, unknown>).providerParams = { imageSize: '8K' };
    const errors = validateRegistry(models).errors;
    expect(errors.length).toBe(6);
    expect(errors[0]).toMatch(/^Model gemini-3-pro-image: .*unknown imageSize: 8K/);
  });

  it('reports a mock model in prod', () => {
    const models = seedCopy();
    entry(models, 'mock').environments = ['dev', 'prod'];
    expect(validateRegistry(models).errors).toEqual(['Model mock: mock models are dev only']);
  });

  it('reports an unknown style in defaultFor', () => {
    const models = seedCopy();
    entry(models, 'mock').defaultFor = ['pixel-art'];
    expect(validateRegistry(models).errors).toEqual([
      expect.stringMatching(/^Model mock: defaultFor\.0: /),
    ]);
  });

  it('reports a style with no default model, or more than one', () => {
    const models = seedCopy();
    entry(models, 'gpt-image-2').defaultFor = ['none', 'watercolour'];
    expect(validateRegistry(models).errors).toEqual([
      'Style watercolour has more than one default model in dev: gpt-image-2, gemini-3.1-flash-image',
      'Style line-art has no default model in dev',
      'Style watercolour has more than one default model in prod: gpt-image-2, gemini-3.1-flash-image',
      'Style line-art has no default model in prod',
    ]);
  });

  it('reports an invalid end-of-life date and unknown fields', () => {
    const models = seedCopy();
    entry(models, 'gemini-3-pro-image').eolDate = '30/06/2027';
    entry(models, 'gpt-image-2').costUnits = 3;
    const errors = validateRegistry(models).errors;
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Model gemini-3-pro-image: eolDate: /),
        expect.stringMatching(/^Model gpt-image-2: .*costUnits/),
      ]),
    );
  });

  it('accepts a valid end-of-life date', () => {
    const models = seedCopy();
    entry(models, 'gemini-3-pro-image').eolDate = '2027-06-30';
    expect(validateRegistry(models).errors).toEqual([]);
  });

  it('labels entries without an id by their index', () => {
    const models = seedCopy();
    models.push({ provider: 'openai' });
    expect(validateRegistry(models).errors[0]).toMatch(/^Model at index 6: /);
  });
});

describe('parseRegistry', () => {
  it('returns the models of a valid registry', () => {
    expect(parseRegistry(seed).map((model) => model.id)).toContain('gpt-image-2');
  });

  it('throws every error at once for an invalid registry', () => {
    const models = seedCopy();
    models.push(structuredClone(entry(models, 'mock')));
    entry(models, 'gpt-image-1-mini').qualities = {};
    try {
      parseRegistry(models);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryValidationError);
      expect((error as RegistryValidationError).errors).toEqual([
        'Model gpt-image-1-mini: has no qualities with a cost',
        'Duplicate model id: mock',
      ]);
      expect((error as Error).message).toContain('- Duplicate model id: mock');
    }
  });
});

describe('registry helpers', () => {
  const models = loadSeedRegistry();

  it('filters models by environment', () => {
    expect(modelsForEnvironment(models, 'prod').map((model) => model.id)).not.toContain('mock');
    expect(modelsForEnvironment(models, 'dev').map((model) => model.id)).toContain('mock');
  });

  it('finds a model by id', () => {
    expect(findModel(models, 'gemini-3-pro-image')?.displayName).toBe('Gemini 3 Pro Image');
    expect(findModel(models, 'missing')).toBeUndefined();
  });

  it('recognises qualities and aspects', () => {
    expect(isQuality('high')).toBe(true);
    expect(isQuality('max')).toBe(false);
    expect(isAspect('9:16')).toBe(true);
    expect(isAspect('4:3')).toBe(false);
  });
});
