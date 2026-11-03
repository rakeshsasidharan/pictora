import {
  APP_GENERATE_DEFAULTS,
  AUTO_MODEL_ID,
  QUALITIES,
  type Aspect,
  type GenerateDefaults,
  type JobStatus,
  type Quality,
  type RoutableModel,
  type RouteReason,
  type StyleId,
} from '@pictora/core';
import type { RerunSettings } from './images';
import type { PublicModel, PublicStyle } from './models_response';

/** How often the generate screen asks for a job's status, and when it stops asking (GEN-8). */
export const POLL_INTERVAL_MS = 2_000;
export const POLL_TIMEOUT_MS = 3 * 60_000;

/**
 * How often the generate screen and the gallery ask about a batch job (tech design 5.4): it can take hours, so
 * once a minute, for as long as the page stays open.
 */
export const BATCH_POLL_INTERVAL_MS = 60_000;
export const BATCH_POLL_TIMEOUT_MS = 24 * 60 * 60_000;

/** The app's default style, for a rerun of an image saved without one: the prompt as typed. */
export const DEFAULT_STYLE: StyleId = APP_GENERATE_DEFAULTS.style;

/** Quality preferred when the chosen model offers it. */
export const DEFAULT_QUALITY: Quality = APP_GENERATE_DEFAULTS.quality;

export const QUALITY_LABELS: Record<Quality, string> = {
  draft: 'Draft',
  standard: 'Standard',
  high: 'High',
};

/** What each job status is called on screen. */
export const STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'Queued',
  running: 'Generating',
  scheduled: 'Scheduled',
  submitted: 'Scheduled',
  succeeded: 'Done',
  failed: 'Failed',
  blocked: 'Blocked',
};

/** The choices on the generate form that depend on the model. */
export interface ModelChoices {
  modelId: string;
  quality: Quality;
  aspect: Aspect;
}

/** Models that can create new images, in registry order. */
export function generateModels(models: readonly PublicModel[]): PublicModel[] {
  return models.filter((model) => model.capabilities.generate);
}

/** The model a style suggests, or the first model when the style suggests none that can generate. */
export function modelForStyle(
  styleId: StyleId,
  styles: readonly PublicStyle[],
  models: readonly PublicModel[],
): PublicModel | undefined {
  const suggested = styles.find((style) => style.id === styleId)?.suggestedModelId;
  return models.find((model) => model.id === suggested) ?? models[0];
}

/** Points per image at the quality, or undefined when the model doesn't offer it. */
export function costPerImage(model: PublicModel, quality: Quality): number | undefined {
  return model.qualities.find((option) => option.quality === quality)?.costPoints;
}

/** True when the quality is paused because the month's platform spend reached the cap (tech design 4.1). */
export function qualityPaused(model: PublicModel, quality: Quality): boolean {
  return model.qualities.some((option) => option.quality === quality && option.paused);
}

/**
 * The quality and aspect to use with a newly chosen model: the current ones when it offers them, otherwise
 * Standard (or the model's first quality) and the model's first aspect. Paused qualities are skipped while
 * another is offered. The registry gives every model at least one of each.
 */
export function choicesForModel(
  model: PublicModel,
  current: { quality: Quality; aspect: Aspect },
): ModelChoices {
  const all = model.qualities.map((option) => option.quality);
  const usable = model.qualities.filter((option) => !option.paused).map((option) => option.quality);
  const offered = usable.length > 0 ? usable : all;
  const quality = offered.includes(current.quality)
    ? current.quality
    : offered.includes(DEFAULT_QUALITY)
      ? DEFAULT_QUALITY
      : (offered[0] ?? current.quality);
  const aspect = model.capabilities.aspects.includes(current.aspect)
    ? current.aspect
    : (model.capabilities.aspects[0] ?? current.aspect);
  return { modelId: model.id, quality, aspect };
}

/** Points the request reserves: the quality's cost per image times the count (LIM-2). */
export function requestCost(model: PublicModel, quality: Quality, count: number): number {
  return (costPerImage(model, quality) ?? 0) * count;
}

/** The model's costs for the picker, for example `Draft 1 · Standard 6 · High 22 points per image`. */
export function modelCostSummary(model: PublicModel): string {
  const costs = model.qualities.map(
    (option) => `${QUALITY_LABELS[option.quality]} ${option.costPoints}`,
  );
  const single = model.qualities.length === 1 && model.qualities[0]?.costPoints === 1;
  return `${costs.join(' · ')} ${single ? 'point' : 'points'} per image`;
}

export function pointsText(points: number): string {
  return `${points} ${points === 1 ? 'point' : 'points'}`;
}

/** Tailwind classes that draw an aspect's shape icon: its ratio, with the longer side the same for every aspect. */
export const ASPECT_SHAPES: Record<Aspect, string> = {
  '1:1': 'w-4 aspect-square',
  '4:5': 'h-4 aspect-[4/5]',
  '3:2': 'w-4 aspect-[3/2]',
  '2:3': 'h-4 aspect-[2/3]',
  '16:9': 'w-4 aspect-video',
  '9:16': 'h-4 aspect-[9/16]',
};

/** Most characters of the prompt used as an image's alt text. */
export const MAX_ALT_TEXT_LENGTH = 150;

/** The prompt as an image's alt text, trimmed to 150 characters. */
export function altTextFor(prompt: string): string {
  const trimmed = prompt.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= MAX_ALT_TEXT_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_ALT_TEXT_LENGTH - 1).trimEnd()}…`;
}

/** For example `1 November`: when paused premium qualities return. */
const PAUSE_END_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});

/** The notice shown while premium qualities are paused until `until` (ISO 8601), tech design 4.1. */
export function premiumPausedText(until: string): string {
  return `Premium models are paused until ${PAUSE_END_FORMAT.format(new Date(until))} because this month's budget is used up. Draft quality still works.`;
}

/** The public models as `routeModel` reads them: costs by quality instead of a list. */
export function routableModels(models: readonly PublicModel[]): RoutableModel[] {
  return models.map((model) => ({
    id: model.id,
    provider: model.provider,
    defaultFor: model.defaultFor,
    capabilities: model.capabilities,
    qualities: Object.fromEntries(
      model.qualities.map((option) => [option.quality, { costPoints: option.costPoints }]),
    ),
  }));
}

/** Qualities paused by the platform spend cap (tech design 4.1), as the public models mark them. */
export function pausedQualities(models: readonly PublicModel[]): Quality[] {
  return QUALITIES.filter((quality) => models.some((model) => qualityPaused(model, quality)));
}

/** Why Auto picked its model, for the line under the cost; undefined when there is nothing to add. */
export function routeReasonText(
  reason: RouteReason,
  quality: Quality,
  styleName: string,
): string | undefined {
  switch (reason) {
    case 'style-default':
      return `the best fit for ${styleName === 'None' ? 'your prompt' : styleName}`;
    case 'text':
      return 'best at words in images';
    case 'affordable':
      return 'it fits the points you have left';
    case 'lower-quality':
      return `${QUALITY_LABELS[quality]} quality fits the points you have left`;
    default:
      return undefined;
  }
}

/**
 * The quality Auto starts with: the wanted one while any model offers it unpaused, else Standard, else the first
 * quality any model offers unpaused (Draft during a premium pause); undefined when every quality is paused.
 */
function autoQuality(models: readonly PublicModel[], wanted: Quality): Quality | undefined {
  const usable = new Set(
    models.flatMap((model) =>
      model.qualities.filter((option) => !option.paused).map((option) => option.quality),
    ),
  );
  if (usable.has(wanted)) return wanted;
  if (usable.has(DEFAULT_QUALITY)) return DEFAULT_QUALITY;
  return QUALITIES.find((quality) => usable.has(quality));
}

/**
 * How the generate form starts: from the user's defaults (GEN-11), or with a gallery image's settings for a rerun
 * (GAL-3).
 */
export interface InitialForm {
  prompt: string;
  avoid: string;
  styleId: StyleId;
  choices?: ModelChoices;
  /** Smart routing picks the model. */
  auto: boolean;
  count: number;
  transparent: boolean;
  /** "Save points: deliver later". */
  later: boolean;
  /** Whether the prompt enhancer starts on (ENH-1). */
  enhance: boolean;
  /** The original seed, kept only when the model is the original one and it takes a seed. */
  seed?: number;
  /** The enhanced prompt the original used, reused as is; undefined when it used the user's own words. */
  enhancedPrompt?: string;
  /** True when a rerun's model is no longer available, so another was picked. */
  modelReplaced: boolean;
  /** True when the user's default model is no longer available, so Auto is on instead. */
  defaultModelMissing: boolean;
}

/**
 * The generate form's first state. A new form takes the user's defaults (GEN-11): their model when it is still
 * available, otherwise Auto; options the model (or, with Auto, every model) doesn't offer fall back as they do
 * when the model changes. A rerun keeps the original prompt, avoid text, style, model, aspect, quality,
 * transparency, seed and enhancer where the model is still available and supports them; otherwise the style's
 * model. The image count and "Save points" aren't stored with an image, so a rerun takes them from the defaults.
 */
export function initialForm(
  styles: readonly PublicStyle[],
  models: readonly PublicModel[],
  rerun?: RerunSettings,
  defaults: GenerateDefaults = APP_GENERATE_DEFAULTS,
): InitialForm {
  const count = defaults.count;
  if (rerun) {
    const styleId = rerun.style ?? DEFAULT_STYLE;
    const original = models.find((model) => model.id === rerun.modelId);
    const model = original ?? modelForStyle(styleId, styles, models);
    return {
      prompt: rerun.prompt,
      avoid: model?.capabilities.negativePrompt ? (rerun.avoid ?? '') : '',
      styleId,
      choices:
        model &&
        choicesForModel(model, {
          quality: rerun.quality ?? DEFAULT_QUALITY,
          aspect: rerun.aspect ?? '1:1',
        }),
      auto: !original,
      count,
      transparent: Boolean(
        model?.capabilities.transparentBackground && rerun.transparentBackground,
      ),
      later: Boolean(defaults.deliverLater && model?.capabilities.batch),
      enhance: rerun.enhancedPrompt !== undefined,
      ...(original?.capabilities.seed && rerun.seed !== undefined ? { seed: rerun.seed } : {}),
      ...(rerun.enhancedPrompt ? { enhancedPrompt: rerun.enhancedPrompt } : {}),
      modelReplaced: !original,
      defaultModelMissing: false,
    };
  }

  const styleId = defaults.style;
  const chosen =
    defaults.modelId === AUTO_MODEL_ID
      ? undefined
      : models.find((model) => model.id === defaults.modelId);
  const auto = !chosen;
  // With Auto, an option counts as offered when any model offers it, as on the screen.
  const offering = chosen ? [chosen] : models;
  const offers = (has: (model: PublicModel) => boolean | undefined) => offering.some(has);
  const model = chosen ?? modelForStyle(styleId, styles, models);
  const fitted =
    model && choicesForModel(model, { quality: defaults.quality, aspect: defaults.aspect });
  const choices =
    fitted &&
    (auto
      ? {
          ...fitted,
          quality: autoQuality(models, defaults.quality) ?? fitted.quality,
          aspect: offers((candidate) => candidate.capabilities.aspects.includes(defaults.aspect))
            ? defaults.aspect
            : fitted.aspect,
        }
      : fitted);
  return {
    prompt: '',
    avoid: offers((candidate) => candidate.capabilities.negativePrompt) ? defaults.avoid : '',
    styleId,
    choices,
    auto,
    count,
    transparent:
      defaults.transparentBackground &&
      offers((candidate) => candidate.capabilities.transparentBackground),
    later: defaults.deliverLater && offers((candidate) => candidate.capabilities.batch),
    enhance: defaults.enhance,
    modelReplaced: false,
    defaultModelMissing: defaults.modelId !== AUTO_MODEL_ID && !chosen,
  };
}
