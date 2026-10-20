import { loadSeedRegistry, type ModelConfig } from '@pictora/core';
import { createRegistryLoader } from '@pictora/core/registry-store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelsResponse } from '../src/lib/models_response';
import { appEnvironment } from '../src/lib/registry';

const seed = loadSeedRegistry();
const loaderFor = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('../src/lib/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/registry')>()),
  registryLoader: () => loaderFor.current,
}));

const pauseFor = vi.hoisted(() => ({ current: undefined as { until: Date } | undefined }));
const spendRead = vi.hoisted(() => vi.fn());

vi.mock('../src/lib/dynamodb', () => ({
  documentClient: () => ({}),
  tableName: () => 'pictora-test',
}));

vi.mock('../src/lib/platform_spend', () => ({
  spendCapCents: () => 2000,
  readPremiumPause: async (...args: unknown[]) => {
    spendRead(...args);
    return pauseFor.current;
  },
}));

const { GET } = await import('../src/app/api/models/route');

function useRegistry(models: ModelConfig[], environment: 'dev' | 'prod') {
  loaderFor.current = createRegistryLoader({ source: async () => models, environment });
}

afterEach(() => {
  vi.unstubAllEnvs();
  pauseFor.current = undefined;
});

describe('GET /api/models', () => {
  it('returns the enabled models with costs and the style presets, cached for 60 s', async () => {
    useRegistry(seed, 'dev');
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, max-age=60');

    const body = await response.json();
    expect(body.models.map((m: { id: string }) => m.id)).toEqual(seed.map((m) => m.id));
    expect(body.models[0]).toEqual({
      id: 'gpt-image-2',
      provider: 'openai',
      displayName: 'GPT Image 2',
      strengths: expect.arrayContaining(['Follows prompts closely']),
      capabilities: expect.objectContaining({ generate: true, edit: true, referenceImages: 3 }),
      qualities: [
        { quality: 'draft', costPoints: 1 },
        { quality: 'standard', costPoints: 6 },
        { quality: 'high', costPoints: 22 },
      ],
      defaultFor: ['line-art', 'none'],
    });
    expect(body.styles).toContainEqual({
      id: 'line-art',
      name: 'Line art',
      suggestedModelId: 'gpt-image-2',
    });
  });

  it('marks every quality but draft paused once the platform cap is reached', async () => {
    useRegistry(seed, 'dev');
    pauseFor.current = { until: new Date('2026-11-01T00:00:00.000Z') };
    const body = await (await GET()).json();

    expect(spendRead).toHaveBeenCalledWith({}, 'pictora-test', 2000, expect.any(Date));
    expect(body.premiumPausedUntil).toBe('2026-11-01T00:00:00.000Z');
    expect(body.models[0].qualities).toEqual([
      { quality: 'draft', costPoints: 1 },
      { quality: 'standard', costPoints: 6, paused: true },
      { quality: 'high', costPoints: 22, paused: true },
    ]);
  });

  it('marks nothing paused below the cap', async () => {
    useRegistry(seed, 'dev');
    const body = await (await GET()).json();
    expect(body.premiumPausedUntil).toBeUndefined();
    expect(JSON.stringify(body.models)).not.toContain('paused');
  });

  it('never exposes provider settings', async () => {
    useRegistry(seed, 'dev');
    const text = await (await GET()).text();
    expect(text).not.toContain('providerParams');
    expect(text).not.toContain('providerModelId');
  });

  it('leaves out switched-off models', async () => {
    useRegistry(
      seed.map((m) => (m.id === 'gpt-image-2' ? { ...m, enabled: false } : m)),
      'dev',
    );
    const body = await (await GET()).json();
    expect(body.models.map((m: { id: string }) => m.id)).not.toContain('gpt-image-2');
    expect(
      body.styles.find((s: { id: string }) => s.id === 'line-art').suggestedModelId,
    ).toBeUndefined();
  });

  it('never lists the mock model in prod', async () => {
    useRegistry(seed, 'prod');
    const body = await (await GET()).json();
    expect(body.models.map((m: { id: string }) => m.id)).not.toContain('mock');
  });
});

describe('modelsResponse', () => {
  it('lists only the qualities a model offers', () => {
    const model = { ...seed[0]!, qualities: { standard: { providerParams: {}, costPoints: 6 } } };
    expect(modelsResponse([model]).models[0]?.qualities).toEqual([
      { quality: 'standard', costPoints: 6 },
    ]);
  });
});

describe('appEnvironment', () => {
  it('uses PICTORA_ENV, and otherwise prod unless running next dev', () => {
    expect(appEnvironment({ PICTORA_ENV: 'dev', NODE_ENV: 'production' })).toBe('dev');
    expect(appEnvironment({ PICTORA_ENV: 'prod', NODE_ENV: 'development' })).toBe('prod');
    expect(appEnvironment({ NODE_ENV: 'development' })).toBe('dev');
    expect(appEnvironment({ NODE_ENV: 'production' })).toBe('prod');
  });
});
