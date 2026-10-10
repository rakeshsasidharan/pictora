/** Style preset ids (GEN-2). `none` sends the prompt without style text. */
export const STYLE_IDS = [
  'photorealistic',
  'cinematic',
  'digital-art',
  'anime',
  'watercolour',
  'oil-painting',
  '3d-render',
  'line-art',
  'none',
] as const;

export type StyleId = (typeof STYLE_IDS)[number];

export interface StylePreset {
  id: StyleId;
  name: string;
  /** Appended to the user's prompt; empty for `none`. */
  styleText: string;
}

/**
 * Style presets in picker order (GEN-2). The suggested model for each style is the registry model that lists
 * the style in `defaultFor` (see `suggestedModelId`), so the registry stays the one place models are chosen.
 */
export const STYLE_PRESETS: readonly StylePreset[] = [
  {
    id: 'photorealistic',
    name: 'Photorealistic',
    styleText:
      'photorealistic photograph, natural lighting, true-to-life colours, sharp focus, fine realistic detail, shot on a full-frame camera with a 50mm lens',
  },
  {
    id: 'cinematic',
    name: 'Cinematic',
    styleText:
      'cinematic film still, dramatic lighting, anamorphic widescreen composition, shallow depth of field, rich colour grading, subtle film grain',
  },
  {
    id: 'digital-art',
    name: 'Digital art',
    styleText:
      'digital illustration, vibrant colours, clean confident shapes, painterly highlights, detailed concept-art finish',
  },
  {
    id: 'anime',
    name: 'Anime',
    styleText:
      'anime style illustration, clean line work, cel shading, expressive characters, vivid colour palette, detailed background art',
  },
  {
    id: 'watercolour',
    name: 'Watercolour',
    styleText:
      'watercolour painting on textured paper, soft translucent washes, gentle colour bleeds, loose brushwork, visible paper grain',
  },
  {
    id: 'oil-painting',
    name: 'Oil painting',
    styleText:
      'oil painting on canvas, rich impasto brushstrokes, layered pigments, warm classical lighting, visible canvas texture',
  },
  {
    id: '3d-render',
    name: '3D render',
    styleText:
      '3D render, physically based materials, soft global illumination, studio lighting, smooth detailed surfaces, octane-style finish',
  },
  {
    id: 'line-art',
    name: 'Line art',
    styleText:
      'black ink line art on a plain white background, clean precise outlines, no shading or colour fill, minimal and elegant',
  },
  { id: 'none', name: 'None', styleText: '' },
];

export function isStyleId(value: string): value is StyleId {
  return (STYLE_IDS as readonly string[]).includes(value);
}

export function stylePreset(styleId: StyleId): StylePreset {
  const preset = STYLE_PRESETS.find((candidate) => candidate.id === styleId);
  if (!preset) throw new Error(`Unknown style preset: ${styleId}`);
  return preset;
}

/** The prompt with the preset's style text appended, as sent to the enhancer or the provider. */
export function applyStyle(prompt: string, styleId: StyleId): string {
  const { styleText } = stylePreset(styleId);
  const trimmed = prompt.trim();
  if (!styleText) return trimmed;
  return `${trimmed.replace(/[\s.,;:]+$/, '')}. Style: ${styleText}.`;
}

/** The id of the first model that lists the style in `defaultFor`, or undefined when none does. */
export function suggestedModelId(
  styleId: StyleId,
  models: readonly { id: string; defaultFor: readonly string[] }[],
): string | undefined {
  return models.find((model) => model.defaultFor.includes(styleId))?.id;
}
