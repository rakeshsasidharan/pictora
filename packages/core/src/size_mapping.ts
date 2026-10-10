import type { Aspect, ModelConfig, Quality } from './registry.js';

export interface Size {
  width: number;
  height: number;
}

/** How one aspect ratio is produced by one model (GEN-3). */
export interface SizeMapping {
  aspect: Aspect;
  /** What the adapter sends: an OpenAI `size` such as `1536x1024`, or a Gemini `aspectRatio` such as `16:9`. */
  providerSize: string;
  /** The size the provider generates. */
  generated: Size;
  /** The size stored, after any centre crop. */
  output: Size;
  /** True when the provider has no native size for the aspect and the image is centre-cropped. */
  crop: boolean;
}

/** Width over height for each aspect. */
export const ASPECT_RATIOS: Record<Aspect, number> = {
  '1:1': 1,
  '4:5': 4 / 5,
  '3:2': 3 / 2,
  '2:3': 2 / 3,
  '16:9': 16 / 9,
  '9:16': 9 / 16,
};

/** OpenAI image sizes; other aspects are generated at the nearest one and centre-cropped. */
export const OPENAI_SIZES: readonly Size[] = [
  { width: 1024, height: 1024 },
  { width: 1536, height: 1024 },
  { width: 1024, height: 1536 },
];

export const GEMINI_IMAGE_SIZES = ['1K', '2K', '4K'] as const;
export type GeminiImageSize = (typeof GEMINI_IMAGE_SIZES)[number];

/** Gemini output sizes per `imageSize` and aspect. Every Pictora aspect is native, so nothing is cropped. */
export const GEMINI_SIZES: Record<GeminiImageSize, Record<Aspect, Size>> = {
  '1K': {
    '1:1': { width: 1024, height: 1024 },
    '4:5': { width: 928, height: 1152 },
    '3:2': { width: 1264, height: 848 },
    '2:3': { width: 848, height: 1264 },
    '16:9': { width: 1376, height: 768 },
    '9:16': { width: 768, height: 1376 },
  },
  '2K': {
    '1:1': { width: 2048, height: 2048 },
    '4:5': { width: 1856, height: 2304 },
    '3:2': { width: 2528, height: 1696 },
    '2:3': { width: 1696, height: 2528 },
    '16:9': { width: 2752, height: 1536 },
    '9:16': { width: 1536, height: 2752 },
  },
  '4K': {
    '1:1': { width: 4096, height: 4096 },
    '4:5': { width: 3712, height: 4608 },
    '3:2': { width: 5056, height: 3392 },
    '2:3': { width: 3392, height: 5056 },
    '16:9': { width: 5504, height: 3072 },
    '9:16': { width: 3072, height: 5504 },
  },
};

/**
 * The size a model generates for an aspect at a quality, and whether it is centre-cropped (GEN-3).
 * Throws when the model doesn't list the aspect or quality, or its provider has no size table.
 */
export function mapAspect(model: ModelConfig, aspect: Aspect, quality: Quality): SizeMapping {
  if (!model.capabilities.aspects.includes(aspect)) {
    throw new Error(`Model ${model.id} does not support aspect ${aspect}`);
  }
  const qualityConfig = model.qualities[quality];
  if (!qualityConfig) throw new Error(`Model ${model.id} does not support quality ${quality}`);

  switch (model.provider) {
    case 'openai':
      return mapToNearestSize(aspect, OPENAI_SIZES);
    case 'gemini':
    case 'mock': {
      const imageSize = qualityConfig.providerParams.imageSize ?? '1K';
      if (!isGeminiImageSize(imageSize)) {
        throw new Error(
          `Model ${model.id} quality ${quality} has an unknown imageSize: ${String(imageSize)}`,
        );
      }
      const size = GEMINI_SIZES[imageSize][aspect];
      return { aspect, providerSize: aspect, generated: size, output: size, crop: false };
    }
    case 'bedrock':
      throw new Error(`Model ${model.id}: Bedrock sizes are not mapped yet`);
  }
}

/** Picks the size whose ratio is nearest the aspect (on a log scale), then centre-crops it to the exact ratio. */
export function mapToNearestSize(aspect: Aspect, sizes: readonly Size[]): SizeMapping {
  const ratio = ASPECT_RATIOS[aspect];
  const distance = (size: Size) => Math.abs(Math.log(size.width / size.height) - Math.log(ratio));
  const generated = sizes.reduce((best, size) => (distance(size) < distance(best) ? size : best));
  const output = centreCropSize(generated, ratio);
  const crop = output.width !== generated.width || output.height !== generated.height;
  return {
    aspect,
    providerSize: `${generated.width}x${generated.height}`,
    generated,
    output,
    crop,
  };
}

/** The largest size with the given width-to-height ratio that fits inside `size`. */
export function centreCropSize(size: Size, ratio: number): Size {
  const current = size.width / size.height;
  if (Math.abs(current - ratio) < 1e-9) return { ...size };
  if (current > ratio) return { width: Math.round(size.height * ratio), height: size.height };
  return { width: size.width, height: Math.round(size.width / ratio) };
}

function isGeminiImageSize(value: unknown): value is GeminiImageSize {
  return typeof value === 'string' && (GEMINI_IMAGE_SIZES as readonly string[]).includes(value);
}
