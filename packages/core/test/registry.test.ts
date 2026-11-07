import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  RegistryValidationError,
  findModel,
  isAspect,
  isQuality,
  loadSeedRegistry,
  modelsForEnvironment,
  modelsForGroups,
  parseRegistry,
  TESTERS_GROUP,
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

  it('holds the five P0 models, the P1 Bedrock models and tools, and the dev-only mock', () => {
    const models = loadSeedRegistry();
    expect(models.map((model) => [model.id, model.provider, model.environments])).toEqual([
      ['gpt-image-2', 'openai', ['dev', 'prod']],
      ['gpt-image-1-mini', 'openai', ['dev', 'prod']],
      ['gemini-3.1-flash-image', 'gemini', ['dev', 'prod']],
      ['gemini-3.1-flash-lite-image', 'gemini', ['dev', 'prod']],
      ['gemini-3-pro-image', 'gemini', ['dev', 'prod']],
      ['stable-image-core', 'bedrock', ['dev', 'prod']],
      ['sd3.5-large', 'bedrock', ['dev', 'prod']],
      ['stable-image-ultra', 'bedrock', ['dev', 'prod']],
      ['stable-fast-upscale', 'bedrock', ['dev', 'prod']],
      ['stable-conservative-upscale', 'bedrock', ['dev', 'prod']],
      ['stable-creative-upscale', 'bedrock', ['dev', 'prod']],
      ['stable-image-remove-background', 'bedrock', ['dev', 'prod']],
      ['stable-image-erase-object', 'bedrock', ['dev', 'prod']],
      ['stable-outpaint', 'bedrock', ['dev', 'prod']],
      ['mock', 'mock', ['dev']],
    ]);
  });

  it('lists the Stability edit tools by model ID, each through its us. inference profile (#35)', () => {
    const tools = loadSeedRegistry().filter((model) => model.tools);
    expect(
      tools.map((model) => [
        model.id,
        model.providerModelId,
        model.inferenceProfileId,
        model.tools,
      ]),
    ).toEqual([
      [
        'stable-fast-upscale',
        'stability.stable-fast-upscale-v1:0',
        'us.stability.stable-fast-upscale-v1:0',
        { 'upscale-fast': { costPoints: 3 } },
      ],
      [
        'stable-conservative-upscale',
        'stability.stable-conservative-upscale-v1:0',
        'us.stability.stable-conservative-upscale-v1:0',
        { 'upscale-conservative': { costPoints: 40 } },
      ],
      [
        'stable-creative-upscale',
        'stability.stable-creative-upscale-v1:0',
        'us.stability.stable-creative-upscale-v1:0',
        { 'upscale-creative': { costPoints: 60 } },
      ],
      [
        'stable-image-remove-background',
        'stability.stable-image-remove-background-v1:0',
        'us.stability.stable-image-remove-background-v1:0',
        { 'remove-background': { costPoints: 7 } },
      ],
      [
        'stable-image-erase-object',
        'stability.stable-image-erase-object-v1:0',
        'us.stability.stable-image-erase-object-v1:0',
        { erase: { costPoints: 7 } },
      ],
      [
        'stable-outpaint',
        'stability.stable-outpaint-v1:0',
        'us.stability.stable-outpaint-v1:0',
        { outpaint: { costPoints: 6 } },
      ],
      ['mock', 'mock', undefined, expect.objectContaining({ erase: { costPoints: 1 } })],
    ]);
    for (const model of tools.filter((tool) => tool.provider === 'bedrock')) {
      expect(model.capabilities).toMatchObject({ generate: false, edit: false, aspects: [] });
      expect(model.qualities).toEqual({});
    }
  });

  it('lists the Stability models on Bedrock by their Bedrock model IDs, for generating only', () => {
    const bedrock = loadSeedRegistry().filter(
      (model) => model.provider === 'bedrock' && !model.tools,
    );
    expect(bedrock.map((model) => model.providerModelId)).toEqual([
      'stability.stable-image-core-v1:1',
      'stability.sd3-5-large-v1:0',
      'stability.stable-image-ultra-v1:1',
    ]);
    for (const model of bedrock) {
      expect(model.capabilities).toMatchObject({
        generate: true,
        edit: false,
        transparentBackground: false,
        negativePrompt: true,
        seed: true,
        referenceImages: 0,
      });
      expect(model.capabilities.aspects).toHaveLength(6);
    }
  });

  it('offers transparent backgrounds only on GPT Image 1 Mini and the mock (GEN-9)', () => {
    const transparent = loadSeedRegistry()
      .filter((model) => model.capabilities.transparentBackground)
      .map((model) => model.id);
    // GPT Image 2 answers 400 to background=transparent (live check, #177).
    expect(transparent).toEqual(['gpt-image-1-mini', 'mock']);
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

  it('allows batch only for providers with a batch API and models that generate', () => {
    const models = seedCopy();
    (entry(models, 'stable-image-core').capabilities as Record<string, unknown>).batch = true;
    expect(validateRegistry(models).errors).toEqual([
      'Model stable-image-core: bedrock has no batch API',
    ]);

    const editOnly = seedCopy();
    const mock = entry(editOnly, 'mock').capabilities as Record<string, unknown>;
    mock.generate = false;
    mock.edit = true;
    expect(validateRegistry(editOnly).errors).toContain(
      'Model mock: batch jobs generate images, so it must support generate',
    );
  });

  it('treats a missing batch capability as no batch', () => {
    const models = seedCopy();
    delete (entry(models, 'gpt-image-2').capabilities as Record<string, unknown>).batch;
    const { models: parsed, errors } = validateRegistry(models);
    expect(errors).toEqual([]);
    expect(parsed.find((model) => model.id === 'gpt-image-2')?.capabilities.batch).toBeUndefined();
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
    expect(validateRegistry(models).errors).toEqual(['Model mock: lists no aspects']);
  });

  it('accepts a model that only runs tools, with no aspects or qualities', () => {
    const models = seedCopy();
    expect(entry(models, 'stable-outpaint').qualities).toEqual({});
    expect(validateRegistry(models).errors).toEqual([]);
  });

  it('reports a model that neither makes images nor runs a tool', () => {
    const models = seedCopy();
    delete entry(models, 'stable-outpaint').tools;
    expect(validateRegistry(models).errors).toEqual([
      'Model stable-outpaint: supports neither generate, edit nor any tool',
    ]);
  });

  it('reports a tool-only model with qualities or style defaults', () => {
    const models = seedCopy();
    entry(models, 'stable-outpaint').defaultFor = ['anime'];
    expect(validateRegistry(models).errors).toEqual(
      expect.arrayContaining([
        'Model stable-outpaint: only runs tools, so it takes no qualities or style defaults',
      ]),
    );
  });

  it('reports tools on a provider that runs none, and an unknown tool', () => {
    const models = seedCopy();
    entry(models, 'gpt-image-2').tools = { erase: { costPoints: 7 } };
    entry(models, 'stable-outpaint').tools = { blur: { costPoints: 1 } };
    expect(validateRegistry(models).errors).toEqual(
      expect.arrayContaining([
        'Model gpt-image-2: openai runs no image tools',
        expect.stringMatching(/^Model stable-outpaint: tools/),
      ]),
    );
  });

  it('reports an inference profile on a model outside Bedrock, or one outside the us. profiles', () => {
    const models = seedCopy();
    entry(models, 'gpt-image-2').inferenceProfileId = 'us.openai.gpt-image-2';
    entry(models, 'stable-outpaint').inferenceProfileId = 'eu.stability.stable-outpaint-v1:0';
    expect(validateRegistry(models).errors).toEqual(
      expect.arrayContaining([
        'Model gpt-image-2: only Bedrock models have inference profiles',
        expect.stringMatching(/^Model stable-outpaint: inferenceProfileId: /),
      ]),
    );
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
    expect(validateRegistry(models).errors[0]).toMatch(/^Model at index 15: /);
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

describe('modelsForGroups', () => {
  const dev = modelsForEnvironment(loadSeedRegistry(), 'dev');

  it('leaves the Mock model out for users outside the testers group', () => {
    for (const groups of [[], ['admins']]) {
      const ids = modelsForGroups(dev, groups).map((model) => model.id);
      expect(ids).not.toContain('mock');
      expect(ids).toHaveLength(dev.length - 1);
    }
  });

  it('keeps every model, Mock included, for the testers group', () => {
    expect(TESTERS_GROUP).toBe('testers');
    expect(modelsForGroups(dev, ['admins', TESTERS_GROUP])).toEqual(dev);
  });

  it('returns a new array, leaving the input untouched', () => {
    const result = modelsForGroups(dev, [TESTERS_GROUP]);
    expect(result).not.toBe(dev);
  });
});
