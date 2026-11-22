import { loadSeedRegistry, type ModelConfig } from '@pictora/core';
import sharp from 'sharp';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Enhance } from '../src/enhancer.js';
import {
  CHECK_ENHANCER_TARGET,
  CHECK_PROMPT,
  LIVE_PROVIDERS,
  OPENAI_API_URL,
  OPENAI_MODERATION_MODEL,
  OpenAiModerationCheck,
  cheapestQuality,
  environmentEnhancer,
  formatResults,
  parseArgs,
  runChecks,
  secretName,
  selectModels,
  type CheckResult,
  type FetchFn,
} from '../scripts/live_check.js';
import type { ImageProvider, ImageRequest, ImageResult } from '../src/types.js';
import { seedModel, solidImage } from './helpers.js';

const gptImage2 = seedModel('gpt-image-2');
const gptMini = seedModel('gpt-image-1-mini');
const geminiLite = seedModel('gemini-3.1-flash-lite-image');

let png: Uint8Array;
let alphaPng: Uint8Array;
beforeAll(async () => {
  png = await solidImage('png', 32, 32);
  alphaPng = new Uint8Array(
    await sharp({
      create: { width: 32, height: 32, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer(),
  );
});

/** A fake `fetch` that answers every call with one JSON response, and records the calls. */
function fakeFetch(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return vi.fn<FetchFn>(
    async () =>
      new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { 'content-type': 'application/json', ...init.headers },
      }),
  );
}

function sent(fetchFn: ReturnType<typeof fakeFetch>, index = 0) {
  const call = fetchFn.mock.calls[index];
  if (!call) throw new Error(`No fetch call ${index}`);
  const [url, init] = call;
  return {
    url: String(url),
    headers: init?.headers as Record<string, string>,
    body: JSON.parse(String(init?.body)) as Record<string, unknown>,
  };
}

describe('parseArgs', () => {
  it('defaults to dev and every live provider', () => {
    expect(parseArgs([])).toEqual({ env: 'dev', providers: ['openai', 'gemini', 'bedrock'] });
    expect(LIVE_PROVIDERS).not.toContain('mock');
  });

  it('reads --env, --provider and --out', () => {
    expect(
      parseArgs(['--env', 'prod', '--provider', 'openai, gemini,openai', '--out', '/x']),
    ).toEqual({ env: 'prod', providers: ['openai', 'gemini'], outDir: '/x' });
  });

  it.each([
    [['--model', 'x'], /Unknown option --model/],
    [['--env'], /--env needs a value/],
    [['--env', '--provider'], /--env needs a value/],
    [['--env', 'staging'], /--env must be one of dev, prod/],
    [['--provider', 'mock'], /--provider must be from openai, gemini, bedrock: mock/],
    [['--enhancer'], /--enhancer needs a value/],
    [['--enhancer', 'openai:gpt-5'], /ENHANCER_MODEL must be/],
  ])('rejects %j', (argv, error) => {
    expect(() => parseArgs(argv)).toThrow(error);
  });

  it('reads --enhancer as a model or none', () => {
    expect(parseArgs(['--enhancer', 'gemini:gemini-3.1-flash-lite']).enhancer).toEqual({
      backend: 'gemini',
      modelId: 'gemini-3.1-flash-lite',
    });
    expect(parseArgs(['--enhancer', 'none']).enhancer).toBe('none');
    expect(parseArgs([])).not.toHaveProperty('enhancer');
  });
});

describe('environmentEnhancer', () => {
  const cdkJson = JSON.parse(
    readFileSync(new URL('../../../infra/cdk.json', import.meta.url), 'utf8'),
  ) as { context: unknown };

  it('reads each environment’s enhancer from infra/cdk.json', () => {
    expect(environmentEnhancer(cdkJson.context, 'dev')).toEqual({
      backend: 'mock',
      modelId: 'mock',
    });
    expect(environmentEnhancer(cdkJson.context, 'prod')).toEqual({
      backend: 'bedrock',
      modelId: 'us.amazon.nova-2-lite-v1:0',
    });
  });

  it('fails when the environment has no enhancer, or an invalid one', () => {
    expect(() => environmentEnhancer({ environments: {} }, 'prod')).toThrow(
      'infra/cdk.json has no enhancerModel for prod',
    );
    expect(() => environmentEnhancer(undefined, 'dev')).toThrow(/no enhancerModel for dev/);
    expect(() =>
      environmentEnhancer({ environments: { dev: { enhancerModel: 'luna' } } }, 'dev'),
    ).toThrow(/ENHANCER_MODEL must be/);
  });
});

describe('selectModels', () => {
  const registry = loadSeedRegistry();

  it('picks enabled live models for the environment, in registry order', () => {
    const ids = selectModels(registry, 'dev', LIVE_PROVIDERS).map((model) => model.id);
    expect(ids).toContain('gpt-image-1-mini');
    expect(ids).toContain('gemini-3-pro-image');
    expect(ids).not.toContain('mock');
    expect(ids.indexOf('gpt-image-2')).toBeLessThan(ids.indexOf('gemini-3.1-flash-image'));
  });

  it('filters by provider', () => {
    const models = selectModels(registry, 'dev', ['gemini']);
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model.provider === 'gemini')).toBe(true);
  });

  it('skips disabled models and models from another environment', () => {
    const disabled: ModelConfig = { ...gptMini, enabled: false };
    const devOnly: ModelConfig = { ...gptImage2, environments: ['dev'] };
    expect(selectModels([disabled, devOnly], 'dev', ['openai'])).toEqual([devOnly]);
    expect(selectModels([disabled, devOnly], 'prod', ['openai'])).toEqual([]);
  });
});

describe('cheapestQuality', () => {
  it.each([
    ['gpt-image-2', 'draft'],
    ['gemini-3.1-flash-image', 'standard'],
    ['sd3.5-large', 'standard'],
    ['stable-image-ultra', 'high'],
  ])('%s uses %s', (id, quality) => {
    expect(cheapestQuality(seedModel(id))).toBe(quality);
  });
});

describe('secretName', () => {
  it('follows pictora/<env>/<provider>', () => {
    expect(secretName('dev', 'openai')).toBe('pictora/dev/openai');
    expect(secretName('prod', 'gemini')).toBe('pictora/prod/gemini');
  });
});

describe('OpenAiModerationCheck', () => {
  it('checks moderation with the omni model', async () => {
    const fetchFn = fakeFetch({ results: [{ flagged: false }] });
    const signal = new AbortController().signal;
    await expect(
      new OpenAiModerationCheck('sk-test', fetchFn).moderate('hi', signal),
    ).resolves.toBe(false);
    expect(sent(fetchFn).url).toBe(`${OPENAI_API_URL}/moderations`);
    expect(sent(fetchFn).body).toEqual({ model: OPENAI_MODERATION_MODEL, input: 'hi' });
  });

  it('fails moderation when the response has no result', async () => {
    const fetchFn = fakeFetch({ results: [] });
    await expect(
      new OpenAiModerationCheck('sk-test', fetchFn).moderate('hi', new AbortController().signal),
    ).rejects.toThrow('OpenAI moderation returned no result');
  });
});

describe('runChecks', () => {
  /** A clock that moves 1.5 s per reading. */
  function clock() {
    let time = 0;
    return () => (time += 1500);
  }

  function adapter(generate: ImageProvider['generate']): ImageProvider {
    return { generate, edit: () => Promise.reject(new Error('unused')) };
  }

  /** Returns a PNG with an alpha channel when a transparent background is asked for. */
  const ok = (_model: ModelConfig, req: ImageRequest): Promise<ImageResult> =>
    Promise.resolve({
      images: [{ png: req.transparentBackground ? alphaPng : png, width: 1024, height: 1024 }],
      providerCostCents: 1,
    });

  it('generates one draft image per model with the check prompt, then checks moderation', async () => {
    const generate = vi.fn<ImageProvider['generate']>(ok);
    const moderate = vi.fn(async () => false);
    const results = await runChecks([gptMini, geminiLite], {
      adapters: { openai: adapter(generate), gemini: adapter(generate) },
      moderate,
      now: clock(),
    });

    expect(generate).toHaveBeenCalledTimes(3);
    expect(generate.mock.calls[0]?.[1]).toMatchObject({
      prompt: CHECK_PROMPT,
      aspect: '1:1',
      quality: 'draft',
      count: 1,
    });
    expect(generate.mock.calls[0]?.[1]).not.toHaveProperty('transparentBackground');
    expect(generate.mock.calls[1]?.[1]).toMatchObject({ transparentBackground: true });
    expect(generate.mock.calls[2]?.[0]).toBe(geminiLite);
    expect(moderate).toHaveBeenCalledWith(CHECK_PROMPT, expect.any(AbortSignal));
    expect(results.map(({ png: image, ...rest }) => ({ ...rest, png: Boolean(image) }))).toEqual([
      {
        name: 'gpt-image-1-mini',
        quality: 'draft',
        ok: true,
        detail: '1024x1024',
        ms: 1500,
        png: true,
      },
      {
        name: 'gpt-image-1-mini-transparent',
        quality: 'draft',
        ok: true,
        detail: '1024x1024 with alpha',
        ms: 1500,
        png: true,
      },
      {
        name: 'gemini-3.1-flash-lite-image',
        quality: 'draft',
        ok: true,
        detail: '1024x1024',
        ms: 1500,
        png: true,
      },
      { name: 'openai-moderation', ok: true, detail: 'not flagged', ms: 1500, png: false },
    ]);
  });

  it('records failures and keeps going', async () => {
    const failing = adapter(() =>
      Promise.reject(
        Object.assign(new Error('Gemini HTTP 403: API key not valid'), { status: 403 }),
      ),
    );
    const results = await runChecks([geminiLite, gptMini], {
      adapters: { gemini: failing, openai: adapter(ok) },
      now: clock(),
    });
    expect(results.map((result) => [result.name, result.ok, result.detail])).toEqual([
      ['gemini-3.1-flash-lite-image', false, 'Gemini HTTP 403: API key not valid'],
      ['gpt-image-1-mini', true, '1024x1024'],
      ['gpt-image-1-mini-transparent', true, '1024x1024 with alpha'],
    ]);
  });

  it('fails the transparent check when the PNG has no alpha channel', async () => {
    const opaque = adapter(() =>
      Promise.resolve({ images: [{ png, width: 32, height: 32 }], providerCostCents: 1 }),
    );
    const results = await runChecks([gptMini], { adapters: { openai: opaque } });
    expect(results.map((result) => [result.name, result.ok, result.detail])).toEqual([
      ['gpt-image-1-mini', true, '32x32'],
      [
        'gpt-image-1-mini-transparent',
        false,
        'The transparent-background PNG has no alpha channel',
      ],
    ]);
  });

  it('fails a model with no adapter, and moderation that flags the harmless prompt or errors', async () => {
    const [missing] = await runChecks([gptMini], { adapters: {} });
    expect(missing).toMatchObject({ ok: false, detail: 'No adapter for openai' });

    const flagged = await runChecks([], { adapters: {}, moderate: async () => true });
    expect(flagged[0]).toMatchObject({ ok: false, detail: 'flagged a harmless prompt' });

    const broken = await runChecks([], {
      adapters: {},
      moderate: () => Promise.reject(new Error('OpenAI moderation HTTP 401: bad key')),
    });
    expect(broken[0]).toMatchObject({ ok: false, detail: 'OpenAI moderation HTTP 401: bad key' });
  });

  it('checks the enhancer last with one rewrite of the check prompt (#195)', async () => {
    const enhance = vi.fn<Enhance>(async () => ({
      enhancedPrompt: 'A glossy red apple on a rustic oak table in soft morning daylight',
      inputTokens: 211,
      outputTokens: 128,
      costCents: 0.04,
      latencyMs: 1900,
    }));
    const results = await runChecks([gptMini], {
      adapters: { openai: adapter(ok) },
      moderate: async () => false,
      enhancer: { name: 'bedrock:us.amazon.nova-2-lite-v1:0', enhance },
      now: clock(),
    });
    expect(enhance).toHaveBeenCalledWith({ prompt: CHECK_PROMPT, model: CHECK_ENHANCER_TARGET });
    expect(results.map((result) => result.name)).toEqual([
      'gpt-image-1-mini',
      'gpt-image-1-mini-transparent',
      'openai-moderation',
      'enhancer bedrock:us.amazon.nova-2-lite-v1:0',
    ]);
    expect(results.at(-1)).toEqual({
      name: 'enhancer bedrock:us.amazon.nova-2-lite-v1:0',
      ok: true,
      detail: '65 characters, 211 in / 128 out tokens',
      ms: 1500,
    });
  });

  it('fails the enhancer check with the provider error, as for a model the account is not offered', async () => {
    const [result] = await runChecks([], {
      adapters: {},
      enhancer: {
        name: 'bedrock:us.openai.gpt-5.6-luna',
        enhance: () =>
          Promise.reject(new Error('openai.gpt-5.6-luna is not available for this account.')),
      },
    });
    expect(result).toMatchObject({
      name: 'enhancer bedrock:us.openai.gpt-5.6-luna',
      ok: false,
      detail: 'openai.gpt-5.6-luna is not available for this account.',
    });
  });
});

describe('formatResults', () => {
  it('prints one aligned line per check', () => {
    const results: CheckResult[] = [
      { name: 'gpt-image-1-mini', quality: 'draft', ok: true, detail: '1024x1024', ms: 8400 },
      { name: 'openai-moderation', ok: false, detail: 'bad key', ms: 300 },
    ];
    expect(formatResults(results)).toBe(
      [
        'PASS  gpt-image-1-mini   draft  8.4s  1024x1024',
        'FAIL  openai-moderation         0.3s  bad key',
      ].join('\n'),
    );
  });
});
