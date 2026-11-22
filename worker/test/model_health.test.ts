import { loadSeedRegistry, type ModelConfig } from '@pictora/core';
import type { EmitMetrics } from '@pictora/core/observability';
import {
  parseEnhancerModel,
  type BedrockModelAccess,
  type ModelCatalogue,
} from '@pictora/providers';
import { describe, expect, it, vi } from 'vitest';
import { log } from '../src/log.js';
import {
  checkEnhancerHealth,
  checkModelHealth,
  deployedCatalogues,
  deployedEnhancer,
  reportModelHealth,
  type BedrockAccessCheck,
  type Catalogues,
  type ModelHealthReport,
} from '../src/model_health.js';

vi.mock('../src/log.js', () => ({ log: vi.fn() }));

const NOW = new Date('2026-10-19T06:00:00.000Z');
const seed = loadSeedRegistry();

/** The ID a provider lists a model by: its inference profile when it has one. */
const listedId = (model: ModelConfig) => model.inferenceProfileId ?? model.providerModelId;

/** Each provider lists every seed model of its own, as a healthy provider does. */
function healthyCatalogues(models: readonly ModelConfig[] = seed): Catalogues {
  const listFor = (provider: string): ModelCatalogue =>
    new Map(
      models
        .filter((model) => model.provider === provider)
        .map((model) => [listedId(model), { legacy: false }]),
    );
  return {
    openai: async () => listFor('openai'),
    gemini: async () => listFor('gemini'),
    bedrock: async () => listFor('bedrock'),
  };
}

describe('checkModelHealth', () => {
  it('passes every enabled model its provider still lists, skipping the mock', async () => {
    const report = await checkModelHealth(seed, healthyCatalogues(), NOW);
    expect(report.problems).toEqual([]);
    expect(report.unavailable).toEqual([]);
    expect(report.checked).toEqual(
      seed.filter((model) => model.provider !== 'mock').map((model) => model.id),
    );
  });

  it('flags a model its provider no longer lists', async () => {
    const catalogues = healthyCatalogues();
    catalogues.openai = async () => new Map([['gpt-image-1-mini', { legacy: false }]]);
    const report = await checkModelHealth(seed, catalogues, NOW);
    expect(report.problems).toEqual([
      {
        modelId: 'gpt-image-2',
        provider: 'openai',
        providerModelId: 'gpt-image-2',
        reason: 'missing',
      },
    ]);
  });

  it('checks a model reached through an inference profile by its profile ID', async () => {
    const tool = seed.find((model) => model.inferenceProfileId !== undefined);
    expect(tool).toBeDefined();
    const catalogues = healthyCatalogues();
    // Bedrock lists the tool only as a profile, not under its foundation model ID.
    const report = await checkModelHealth(seed, catalogues, NOW);
    expect(report.problems).toEqual([]);
    expect(report.checked).toContain(tool!.id);

    // Listed under its foundation model ID but without its profile, it can't be invoked.
    catalogues.bedrock = async () =>
      new Map(
        seed
          .filter((model) => model.provider === 'bedrock')
          .map((model) => [model.providerModelId, { legacy: false }]),
      );
    const missing = await checkModelHealth(seed, catalogues, NOW);
    expect(missing.problems).toContainEqual({
      modelId: tool!.id,
      provider: 'bedrock',
      providerModelId: tool!.providerModelId,
      inferenceProfileId: tool!.inferenceProfileId,
      reason: 'missing',
    });
    expect(missing.problems.every((problem) => problem.inferenceProfileId !== undefined)).toBe(
      true,
    );
  });

  it('flags a model whose registry eolDate is within 60 days, and not one further out', async () => {
    const models = seed.map((model) =>
      model.id === 'gemini-3-pro-image'
        ? { ...model, eolDate: '2026-11-18' }
        : model.id === 'gpt-image-2'
          ? { ...model, eolDate: '2026-12-19' }
          : model,
    );
    const report = await checkModelHealth(models, healthyCatalogues(models), NOW);
    expect(report.problems).toEqual([
      {
        modelId: 'gemini-3-pro-image',
        provider: 'gemini',
        providerModelId: 'gemini-3-pro-image',
        reason: 'retiring',
        eolDate: '2026-11-18',
      },
    ]);
  });

  it('flags the 60th day and a date already past', async () => {
    const models = seed.map((model) =>
      model.id === 'gpt-image-2'
        ? { ...model, eolDate: '2026-12-18' }
        : model.id === 'gpt-image-1-mini'
          ? { ...model, eolDate: '2026-10-01' }
          : model,
    );
    const report = await checkModelHealth(models, healthyCatalogues(models), NOW);
    expect(report.problems.map((problem) => problem.modelId)).toEqual([
      'gpt-image-2',
      'gpt-image-1-mini',
    ]);
  });

  it("uses the provider's own end-of-life date and legacy status", async () => {
    const catalogues = healthyCatalogues();
    // The image tools' Stability models are listed too, and healthy.
    const healthy = seed
      .filter((model) => model.provider === 'bedrock')
      .map((model) => [listedId(model), { legacy: false }] as const);
    catalogues.bedrock = async () =>
      new Map<string, { legacy: boolean; endOfLife?: string }>([
        ...healthy,
        ['stability.stable-image-core-v1:1', { legacy: true, endOfLife: '2026-12-01' }],
        ['stability.sd3-5-large-v1:0', { legacy: true }],
      ]);
    const report = await checkModelHealth(seed, catalogues, NOW);
    expect(report.problems).toEqual([
      expect.objectContaining({
        modelId: 'stable-image-core',
        reason: 'retiring',
        eolDate: '2026-12-01',
      }),
      expect.objectContaining({ modelId: 'sd3.5-large', reason: 'deprecated' }),
    ]);
  });

  it('does not raise a false alarm when a provider API fails', async () => {
    const catalogues = healthyCatalogues();
    catalogues.gemini = async () => {
      throw new Error('HTTP 503');
    };
    const report = await checkModelHealth(seed, catalogues, NOW);
    expect(report.problems).toEqual([]);
    expect(report.unavailable).toEqual(['gemini']);
    expect(report.checked).not.toContain('gemini-3-pro-image');
    expect(report.checked).toContain('gpt-image-2');
    expect(log).toHaveBeenCalledWith(
      'WARN',
      'Provider models list unavailable; its models are not checked',
      expect.objectContaining({ provider: 'gemini' }),
    );
  });

  it('ignores switched-off models', async () => {
    const models = seed.map((model) =>
      model.id === 'gpt-image-2' ? { ...model, enabled: false } : model,
    );
    const catalogues = healthyCatalogues();
    catalogues.openai = async () => new Map();
    const report = await checkModelHealth(models, catalogues, NOW);
    expect(report.problems.map((problem) => problem.modelId)).toEqual(['gpt-image-1-mini']);
  });
});

describe('reportModelHealth', () => {
  it('publishes the problem count, 0 when healthy, and logs each problem', () => {
    const metrics = vi.fn<EmitMetrics>();
    reportModelHealth({ checked: ['a'], problems: [], unavailable: [] }, metrics);
    expect(metrics).toHaveBeenLastCalledWith([
      { name: 'ModelHealthProblems', value: 0, unit: 'Count' },
    ]);
    reportModelHealth(
      {
        checked: ['gpt-image-2'],
        problems: [
          {
            modelId: 'gpt-image-2',
            provider: 'openai',
            providerModelId: 'gpt-image-2',
            reason: 'missing',
          },
        ],
        unavailable: [],
      },
      metrics,
    );
    expect(metrics).toHaveBeenLastCalledWith([
      { name: 'ModelHealthProblems', value: 1, unit: 'Count' },
    ]);
    expect(log).toHaveBeenCalledWith(
      'ERROR',
      'Model health problem',
      expect.objectContaining({ modelId: 'gpt-image-2', reason: 'missing' }),
    );
  });
});

describe('deployedCatalogues', () => {
  it('needs both secret names', () => {
    expect(() => deployedCatalogues({})).toThrow('OPENAI_SECRET_ID is not set');
    expect(() => deployedCatalogues({ OPENAI_SECRET_ID: 'pictora/dev/openai' })).toThrow(
      'GEMINI_SECRET_ID is not set',
    );
    const catalogues = deployedCatalogues({
      OPENAI_SECRET_ID: 'pictora/dev/openai',
      GEMINI_SECRET_ID: 'pictora/dev/gemini',
    });
    expect(Object.keys(catalogues)).toEqual(['openai', 'gemini', 'bedrock']);
  });
});

describe('checkEnhancerHealth', () => {
  const NOVA = parseEnhancerModel('bedrock:us.amazon.nova-2-lite-v1:0');
  const CALLABLE: BedrockModelAccess = {
    agreement: 'AVAILABLE',
    authorization: 'AUTHORIZED',
    entitlement: 'AVAILABLE',
    region: 'AVAILABLE',
  };
  const empty = (): ModelHealthReport => ({
    checked: ['gpt-image-2'],
    problems: [],
    unavailable: [],
  });
  const access =
    (result: BedrockModelAccess | undefined): BedrockAccessCheck =>
    async () =>
      result;

  it('passes a Bedrock enhancer the account can call, asking by its profile ID', async () => {
    const bedrockAccess = vi.fn<BedrockAccessCheck>(async () => CALLABLE);
    const report = await checkEnhancerHealth(empty(), NOVA, {
      bedrockAccess,
      catalogues: healthyCatalogues(),
    });
    expect(bedrockAccess).toHaveBeenCalledWith('us.amazon.nova-2-lite-v1:0');
    expect(report).toEqual({
      checked: ['gpt-image-2', 'bedrock:us.amazon.nova-2-lite-v1:0'],
      problems: [],
      unavailable: [],
    });
  });

  it('flags a listed Bedrock enhancer with no Marketplace agreement as not callable (#194)', async () => {
    const luna = parseEnhancerModel('bedrock:us.openai.gpt-5.6-luna');
    const denied = { ...CALLABLE, agreement: 'NOT_AVAILABLE' };
    const report = await checkEnhancerHealth(empty(), luna, {
      bedrockAccess: access(denied),
      catalogues: healthyCatalogues(),
    });
    expect(report.problems).toEqual([
      {
        modelId: 'bedrock:us.openai.gpt-5.6-luna',
        provider: 'bedrock',
        providerModelId: 'openai.gpt-5.6-luna',
        inferenceProfileId: 'us.openai.gpt-5.6-luna',
        reason: 'not_callable',
        access: denied,
      },
    ]);
    expect(report.checked).toContain('bedrock:us.openai.gpt-5.6-luna');
  });

  it('flags a Bedrock enhancer Bedrock does not know as missing, with no profile for a bare model', async () => {
    const report = await checkEnhancerHealth(
      empty(),
      parseEnhancerModel('bedrock:amazon.retired-v1:0'),
      { bedrockAccess: access(undefined), catalogues: healthyCatalogues() },
    );
    expect(report.problems).toEqual([
      {
        modelId: 'bedrock:amazon.retired-v1:0',
        provider: 'bedrock',
        providerModelId: 'amazon.retired-v1:0',
        reason: 'missing',
      },
    ]);
  });

  it('marks Bedrock unavailable, without a problem, when the access check fails', async () => {
    const report = await checkEnhancerHealth(empty(), NOVA, {
      bedrockAccess: () => Promise.reject(new Error('ThrottlingException')),
      catalogues: healthyCatalogues(),
    });
    expect(report).toEqual({ checked: ['gpt-image-2'], problems: [], unavailable: ['bedrock'] });
    expect(log).toHaveBeenCalledWith(
      'WARN',
      'Enhancer check unavailable; the enhancer is not checked',
      expect.objectContaining({ enhancerModel: 'bedrock:us.amazon.nova-2-lite-v1:0' }),
    );

    // A provider already unavailable from the image models' check is listed once.
    const already = await checkEnhancerHealth({ ...empty(), unavailable: ['bedrock'] }, NOVA, {
      bedrockAccess: () => Promise.reject(new Error('ThrottlingException')),
      catalogues: healthyCatalogues(),
    });
    expect(already.unavailable).toEqual(['bedrock']);
  });

  it('checks a Gemini enhancer against the Gemini models list', async () => {
    const flash = parseEnhancerModel('gemini:gemini-3.1-flash-lite');
    const listed: Catalogues = {
      ...healthyCatalogues(),
      gemini: async () => new Map([['gemini-3.1-flash-lite', { legacy: false }]]),
    };
    const bedrockAccess = vi.fn<BedrockAccessCheck>();
    const passed = await checkEnhancerHealth(empty(), flash, { bedrockAccess, catalogues: listed });
    expect(passed.problems).toEqual([]);
    expect(passed.checked).toContain('gemini:gemini-3.1-flash-lite');
    expect(bedrockAccess).not.toHaveBeenCalled();

    const missing = await checkEnhancerHealth(empty(), flash, {
      bedrockAccess,
      catalogues: { ...healthyCatalogues(), gemini: async () => new Map() },
    });
    expect(missing.problems).toEqual([
      {
        modelId: 'gemini:gemini-3.1-flash-lite',
        provider: 'gemini',
        providerModelId: 'gemini-3.1-flash-lite',
        reason: 'missing',
      },
    ]);

    const down = await checkEnhancerHealth(empty(), flash, {
      bedrockAccess,
      catalogues: {
        ...healthyCatalogues(),
        gemini: () => Promise.reject(new Error('HTTP 503')),
      },
    });
    expect(down).toEqual({ checked: ['gpt-image-2'], problems: [], unavailable: ['gemini'] });
  });

  it('skips the mock enhancer', async () => {
    const bedrockAccess = vi.fn<BedrockAccessCheck>();
    const report = await checkEnhancerHealth(empty(), parseEnhancerModel('mock'), {
      bedrockAccess,
      catalogues: healthyCatalogues(),
    });
    expect(report).toEqual(empty());
    expect(bedrockAccess).not.toHaveBeenCalled();
  });

  it('counts an enhancer problem in the published metric', async () => {
    const report = await checkEnhancerHealth(empty(), NOVA, {
      bedrockAccess: access({ ...CALLABLE, authorization: 'NOT_AUTHORIZED' }),
      catalogues: healthyCatalogues(),
    });
    const metrics = vi.fn<EmitMetrics>();
    reportModelHealth(report, metrics);
    expect(metrics).toHaveBeenCalledWith([
      { name: 'ModelHealthProblems', value: 1, unit: 'Count' },
    ]);
    expect(log).toHaveBeenCalledWith(
      'ERROR',
      'Model health problem',
      expect.objectContaining({
        modelId: 'bedrock:us.amazon.nova-2-lite-v1:0',
        reason: 'not_callable',
      }),
    );
  });
});

describe('deployedEnhancer', () => {
  it('reads ENHANCER_MODEL, and fails when it is unset or invalid', () => {
    expect(deployedEnhancer({ ENHANCER_MODEL: 'bedrock:us.amazon.nova-2-lite-v1:0' })).toEqual({
      backend: 'bedrock',
      modelId: 'us.amazon.nova-2-lite-v1:0',
    });
    expect(deployedEnhancer({ ENHANCER_MODEL: 'mock' })).toEqual({
      backend: 'mock',
      modelId: 'mock',
    });
    expect(() => deployedEnhancer({})).toThrow(/ENHANCER_MODEL must be/);
    expect(() => deployedEnhancer({ ENHANCER_MODEL: 'luna' })).toThrow(/ENHANCER_MODEL must be/);
  });
});
