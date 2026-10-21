import {
  STYLE_IDS,
  applyStyle,
  modelsForEnvironment,
  suggestedModelId,
  type ModelConfig,
  type Quality,
  type StyleId,
} from '@pictora/core';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { SAMPLE_IMAGE_SIZE, type SampleImage } from '../../../app/src/lib/sample_images.js';
import { cheapestQuality } from './live_check.js';

/**
 * Generates the style sample images that the landing page and the style picker show (#86). Each sample is
 * made with its style's suggested model from the prompt in `app/src/lib/sample_images.ts`, then saved over
 * the file the app already references.
 */

/** The app's public folder; sample `src` paths are relative to it. */
export const APP_PUBLIC_DIR = fileURLToPath(new URL('../../../app/public', import.meta.url));

/** Sample files stay under about 60 KB for a fast landing page. */
export const SAMPLE_MAX_BYTES = 60 * 1024;

/** WebP qualities tried in turn until the file fits under the size limit. */
export const WEBP_QUALITIES = [85, 80, 75, 70, 65, 60, 55, 50] as const;

export interface SamplePlan {
  style: SampleImage['style'];
  model: ModelConfig;
  quality: Quality;
  /** The sample prompt with the style text applied, as the generate screen sends it. */
  prompt: string;
  /** Absolute path of the file to overwrite. */
  file: string;
}

/** Parses `--style <id>`; with no options every sample is generated. */
export function parseSampleArgs(argv: readonly string[]): { style?: StyleId } {
  if (argv.length === 0) return {};
  const [flag, value, ...rest] = argv;
  if (flag !== '--style' || value === undefined || rest.length > 0) {
    throw new Error('Usage: generate:samples [-- --style <id>]');
  }
  if (!(STYLE_IDS as readonly string[]).includes(value) || value === 'none') {
    throw new Error(`--style must be one of ${STYLE_IDS.filter((id) => id !== 'none').join(', ')}`);
  }
  return { style: value as StyleId };
}

/** Standard quality when the model has it, so samples show what users usually get; otherwise the cheapest. */
export function sampleQuality(model: ModelConfig): Quality {
  return model.qualities.standard ? 'standard' : cheapestQuality(model);
}

/** One plan per sample, using the model the registry suggests for its style among enabled dev models. */
export function planSamples(
  samples: readonly SampleImage[],
  registry: readonly ModelConfig[],
  options: { style?: StyleId; publicDir?: string } = {},
): SamplePlan[] {
  const models = modelsForEnvironment(registry, 'dev').filter(
    (model) => model.enabled && model.capabilities.generate,
  );
  const chosen = options.style
    ? samples.filter((sample) => sample.style === options.style)
    : samples;
  if (chosen.length === 0) throw new Error(`No sample for style ${options.style}`);
  return chosen.map((sample) => {
    const modelId = suggestedModelId(sample.style, models);
    const model = models.find((candidate) => candidate.id === modelId);
    if (!model) throw new Error(`No enabled model is suggested for style ${sample.style}`);
    return {
      style: sample.style,
      model,
      quality: sampleQuality(model),
      prompt: applyStyle(sample.prompt, sample.style),
      file: join(options.publicDir ?? APP_PUBLIC_DIR, sample.src),
    };
  });
}

export interface SampleWebp {
  webp: Uint8Array;
  /** The WebP quality that fitted under the limit. */
  quality: number;
}

/**
 * Centre-crops the image to a square, resizes it to the sample size and encodes WebP at the highest quality
 * in `WEBP_QUALITIES` that fits under `SAMPLE_MAX_BYTES`.
 */
export async function toSampleWebp(image: Uint8Array): Promise<SampleWebp> {
  const square = await sharp(image)
    .resize(SAMPLE_IMAGE_SIZE, SAMPLE_IMAGE_SIZE, { fit: 'cover', position: 'centre' })
    .toBuffer();
  for (const quality of WEBP_QUALITIES) {
    const webp = await sharp(square).webp({ quality, effort: 6 }).toBuffer();
    if (webp.length <= SAMPLE_MAX_BYTES) return { webp: new Uint8Array(webp), quality };
  }
  throw new Error(
    `The image does not fit in ${SAMPLE_MAX_BYTES / 1024} KB even at WebP quality ${WEBP_QUALITIES.at(-1)}`,
  );
}
