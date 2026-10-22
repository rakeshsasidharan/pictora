import { QUALITIES, type Aspect, type ModelConfig, type Quality } from './registry.js';
import type { StyleId } from './styles.js';

/** The model ID a generate request sends to let the app pick the model (smart routing, PRD P1). */
export const AUTO_MODEL_ID = 'auto';

/**
 * Models strong at rendering words in the image, best first. A prompt that asks for text tries them before the
 * style's default.
 */
export const TEXT_MODELS: readonly string[] = ['gpt-image-2'];

/**
 * Where Auto looks after the style's default, best first, for each style. Models not listed come after, in
 * registry order, and mock models last of all. A table rather than a model call, so routing is cheap and
 * predictable.
 */
export const STYLE_FALLBACKS: Readonly<Record<StyleId, readonly string[]>> = {
  photorealistic: ['stable-image-ultra', 'gpt-image-2', 'gemini-3.1-flash-image', 'sd3.5-large'],
  cinematic: ['stable-image-ultra', 'gemini-3.1-flash-image', 'gpt-image-2', 'sd3.5-large'],
  'digital-art': ['sd3.5-large', 'gpt-image-2', 'gemini-3-pro-image'],
  anime: ['sd3.5-large', 'gpt-image-2', 'gemini-3-pro-image'],
  watercolour: ['sd3.5-large', 'gpt-image-2', 'gemini-3-pro-image'],
  'oil-painting': ['sd3.5-large', 'gemini-3-pro-image', 'gpt-image-2'],
  '3d-render': ['gpt-image-2', 'sd3.5-large', 'gemini-3-pro-image'],
  'line-art': ['gemini-3.1-flash-image', 'sd3.5-large'],
  none: ['gemini-3.1-flash-image', 'gemini-3-pro-image', 'sd3.5-large'],
};

/** What the image needs from the model. */
export interface RoutingNeeds {
  /** A transparent background: only models that make one. */
  transparentBackground?: boolean;
  /** Words in the image: models strong at text first (`promptAsksForText`). */
  text?: boolean;
  /** An edit of an existing image rather than a new one. */
  edit?: boolean;
}

/** The parts of a registry entry routing reads, so the browser can route its public model list too. */
export type RoutableModel = Pick<ModelConfig, 'id' | 'provider' | 'defaultFor'> & {
  capabilities: Pick<
    ModelConfig['capabilities'],
    'generate' | 'edit' | 'transparentBackground' | 'aspects'
  >;
  qualities: Partial<Record<Quality, { costPoints: number }>>;
};

export interface RouteRequest {
  style: StyleId;
  quality: Quality;
  aspect: Aspect;
  needs?: RoutingNeeds;
  /** Points the user has left today. */
  pointsLeft: number;
  /** Images requested; the cost is per image. */
  count?: number;
  /** The enabled models the app can queue jobs for, in registry order. */
  models: readonly RoutableModel[];
  /** Qualities paused because the month's platform spend reached the cap (tech design 4.1). */
  pausedQualities?: readonly Quality[];
}

/** Why Auto picked the model. */
export type RouteReason =
  /** The model the style names in the registry. */
  | 'style-default'
  /** A model strong at text, for a prompt that asks for words in the image. */
  | 'text'
  /** The style's default is switched off or lacks a needed capability. */
  | 'fallback'
  /** The first choice costs more than the points left; this one fits at the same quality. */
  | 'affordable'
  /** Nothing fits at the quality asked for; this one fits at a lower quality. */
  | 'lower-quality'
  /** Nothing fits the points left; the first choice, which the job API will refuse. */
  | 'unaffordable';

export interface Route {
  modelId: string;
  quality: Quality;
  /** Points the request costs with this model and quality. */
  points: number;
  reason: RouteReason;
}

/**
 * Smart routing (PRD P1, GEN-5): picks the model and quality for a request. It prefers the style's default model
 * (or a text model when the prompt asks for words), falls back through the style's table to the next enabled
 * model with the needed capabilities, skips paused qualities, and when the first choice costs more than the
 * points left, takes the best model that fits at the same quality, then at each lower quality. Undefined when no
 * enabled model can make the image at all.
 */
export function routeModel(request: RouteRequest): Route | undefined {
  const { style, needs = {}, pointsLeft, count = 1, pausedQualities = [] } = request;
  const capable = request.models.filter(
    (model) =>
      (needs.edit ? model.capabilities.edit : model.capabilities.generate) &&
      (!needs.transparentBackground || model.capabilities.transparentBackground),
  );
  // Every registry model supports every aspect today; a model that doesn't is only skipped while another does.
  const withAspect = capable.filter((model) => model.capabilities.aspects.includes(request.aspect));
  const ordered = preferenceOrder(withAspect.length > 0 ? withAspect : capable, style, needs);
  if (ordered.length === 0) return undefined;

  const usable = (quality: Quality) => !pausedQualities.includes(quality);
  const cost = (model: RoutableModel, quality: Quality) => {
    const config = model.qualities[quality];
    return config && usable(quality) ? config.costPoints * count : undefined;
  };
  const route = (model: RoutableModel, quality: Quality, reason: RouteReason): Route => ({
    modelId: model.id,
    quality,
    points: cost(model, quality)!,
    reason,
  });

  // The first choice: the best model at the quality asked for, or else the nearest quality it can have.
  const qualities = qualityOrder(request.quality);
  let first: { model: RoutableModel; quality: Quality; index: number } | undefined;
  for (const quality of qualities) {
    const index = ordered.findIndex((entry) => cost(entry.model, quality) !== undefined);
    if (index >= 0) {
      first = { model: ordered[index]!.model, quality, index };
      break;
    }
  }
  if (!first) return undefined;
  const firstReason = first.index === 0 ? ordered[0]!.reason : 'fallback';
  if (cost(first.model, first.quality)! <= pointsLeft) {
    return route(first.model, first.quality, firstReason);
  }

  // Too dear: the best model that fits at the same quality, then at each lower one.
  const sameQuality = ordered.find((entry) => {
    const points = cost(entry.model, first.quality);
    return points !== undefined && points <= pointsLeft;
  });
  if (sameQuality) return route(sameQuality.model, first.quality, 'affordable');
  for (const quality of QUALITIES.slice(0, QUALITIES.indexOf(first.quality)).reverse()) {
    const fits = ordered.find((entry) => {
      const points = cost(entry.model, quality);
      return points !== undefined && points <= pointsLeft;
    });
    if (fits) return route(fits.model, quality, 'lower-quality');
  }
  return route(first.model, first.quality, 'unaffordable');
}

/** The capable models, best first, each with why it is where it is. */
function preferenceOrder(
  models: readonly RoutableModel[],
  style: StyleId,
  needs: RoutingNeeds,
): { model: RoutableModel; reason: RouteReason }[] {
  const ordered: { model: RoutableModel; reason: RouteReason }[] = [];
  const add = (model: RoutableModel | undefined, reason: RouteReason) => {
    if (model && !ordered.some((entry) => entry.model.id === model.id)) {
      ordered.push({ model, reason });
    }
  };
  const byId = (id: string) => models.find((model) => model.id === id);
  if (needs.text) for (const id of TEXT_MODELS) add(byId(id), 'text');
  add(
    models.find((model) => model.defaultFor.includes(style)),
    'style-default',
  );
  for (const id of STYLE_FALLBACKS[style]) add(byId(id), 'fallback');
  for (const model of models) if (model.provider !== 'mock') add(model, 'fallback');
  for (const model of models) add(model, 'fallback');
  return ordered;
}

/** The quality asked for, then each lower one, then each higher one. */
function qualityOrder(quality: Quality): Quality[] {
  const index = QUALITIES.indexOf(quality);
  return [quality, ...QUALITIES.slice(0, index).reverse(), ...QUALITIES.slice(index + 1)];
}

/**
 * True when the prompt asks for words in the image: quoted text, or phrases such as "that says", "with the
 * text", "lettering", "logo", "caption", "headline" or "typography".
 */
export function promptAsksForText(prompt: string): boolean {
  if (/["“”«»]\s*[^"“”«»\s][^"“”«»]*["“”«»]/.test(prompt)) return true;
  return TEXT_PATTERNS.some((pattern) => pattern.test(prompt));
}

const TEXT_PATTERNS: readonly RegExp[] = [
  /\b(that|which)\s+(says|reads|spells)\b/i,
  /\b(saying|reading|spelling)\s+["“']?\w/i,
  /\bwith\s+(the\s+)?(words?|text|title|caption|slogan|name)\b/i,
  /\b(lettering|typography|typeface|font|calligraphy|wordmark|logo|caption|headline|slogan|signage)\b/i,
  /\b(poster|banner|sign|label|book cover|menu|infographic)\s+(that|which|with|saying|reading)\b/i,
];
