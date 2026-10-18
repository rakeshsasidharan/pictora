import { loadSeedRegistry, type ModelConfig } from '@pictora/core';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { SAMPLE_IMAGES } from '../../../app/src/lib/sample_images.js';
import {
  APP_PUBLIC_DIR,
  SAMPLE_MAX_BYTES,
  parseSampleArgs,
  planSamples,
  sampleQuality,
  toSampleWebp,
} from '../scripts/style_samples.js';
import { seedModel } from './helpers.js';

const registry = loadSeedRegistry();

describe('parseSampleArgs', () => {
  it('generates every sample by default', () => {
    expect(parseSampleArgs([])).toEqual({});
  });

  it('reads --style', () => {
    expect(parseSampleArgs(['--style', 'anime'])).toEqual({ style: 'anime' });
  });

  it.each([[['--style']], [['--style', 'none']], [['--style', 'pastel']], [['--env', 'dev']]])(
    'rejects %j',
    (argv) => {
      expect(() => parseSampleArgs(argv)).toThrow();
    },
  );
});

describe('sampleQuality', () => {
  it.each([
    ['gpt-image-2', 'standard'],
    ['gemini-3-pro-image', 'standard'],
    ['gpt-image-1-mini', 'draft'],
    ['stable-image-ultra', 'high'],
  ])('%s uses %s', (id, quality) => {
    expect(sampleQuality(seedModel(id))).toBe(quality);
  });
});

describe('planSamples', () => {
  it('plans one sample per style with its suggested model, styled prompt and file', () => {
    const plans = planSamples(SAMPLE_IMAGES, registry);
    expect(plans.map((plan) => plan.style)).toEqual(SAMPLE_IMAGES.map((sample) => sample.style));

    const photo = plans.find((plan) => plan.style === 'photorealistic');
    expect(photo?.model.id).toBe('gemini-3-pro-image');
    expect(photo?.quality).toBe('standard');
    expect(photo?.prompt).toMatch(
      /^A golden retriever puppy .*\. Style: photorealistic photograph/,
    );
    expect(photo?.file).toBe(`${APP_PUBLIC_DIR}/static/samples/photorealistic.webp`);

    expect(plans.find((plan) => plan.style === 'line-art')?.model.id).toBe('gpt-image-2');
  });

  it('plans a single style when asked', () => {
    const plans = planSamples(SAMPLE_IMAGES, registry, { style: 'anime', publicDir: '/pub' });
    expect(plans).toHaveLength(1);
    expect(plans[0]?.file).toBe('/pub/static/samples/anime.webp');
  });

  it('skips disabled models when choosing', () => {
    const withoutPro = registry.map((model): ModelConfig =>
      model.id === 'gemini-3-pro-image' ? { ...model, enabled: false } : model,
    );
    expect(() => planSamples(SAMPLE_IMAGES, withoutPro, { style: 'photorealistic' })).toThrow(
      'No enabled model is suggested for style photorealistic',
    );
  });
});

/** A PNG of random noise; a higher sigma compresses worse. */
async function noise(width: number, height: number, sigma: number): Promise<Uint8Array> {
  const png = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
      noise: { type: 'gaussian', mean: 128, sigma },
    },
  })
    .png()
    .toBuffer();
  return new Uint8Array(png);
}

describe('toSampleWebp', () => {
  it('centre-crops to a 512 px square WebP, lowering quality to fit the size limit', async () => {
    const { webp, quality } = await toSampleWebp(await noise(1536, 1024, 30));
    const meta = await sharp(webp).metadata();
    expect(meta.format).toBe('webp');
    expect([meta.width, meta.height]).toEqual([512, 512]);
    expect(webp.length).toBeLessThanOrEqual(SAMPLE_MAX_BYTES);
    expect(quality).toBeLessThan(85);
  });

  it('keeps the top quality when the image is already small', async () => {
    const flat = await sharp({
      create: { width: 1024, height: 1024, channels: 3, background: { r: 30, g: 120, b: 200 } },
    })
      .png()
      .toBuffer();
    const { quality } = await toSampleWebp(new Uint8Array(flat));
    expect(quality).toBe(85);
  });

  it('fails when even the lowest quality is over the limit', async () => {
    await expect(toSampleWebp(await noise(1024, 1024, 120))).rejects.toThrow(
      'The image does not fit in 60 KB even at WebP quality 50',
    );
  });
});
