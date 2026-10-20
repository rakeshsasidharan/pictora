import { loadSeedRegistry, type ModelConfig } from '@pictora/core';
import type { EmitMetrics } from '@pictora/core/observability';
import type { ModelCatalogue } from '@pictora/providers';
import { describe, expect, it, vi } from 'vitest';
import { log } from '../src/log.js';
import {
  checkModelHealth,
  deployedCatalogues,
  reportModelHealth,
  type Catalogues,
} from '../src/model_health.js';

vi.mock('../src/log.js', () => ({ log: vi.fn() }));

const NOW = new Date('2026-10-19T06:00:00.000Z');
const seed = loadSeedRegistry();

/** Each provider lists every seed model of its own, as a healthy provider does. */
function healthyCatalogues(models: readonly ModelConfig[] = seed): Catalogues {
  const listFor = (provider: string): ModelCatalogue =>
    new Map(
      models
        .filter((model) => model.provider === provider)
        .map((model) => [model.providerModelId, { legacy: false }]),
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
    catalogues.bedrock = async () =>
      new Map([
        ['stability.stable-image-core-v1:1', { legacy: true, endOfLife: '2026-12-01' }],
        ['stability.sd3-5-large-v1:0', { legacy: true }],
        ['stability.stable-image-ultra-v1:1', { legacy: false }],
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
