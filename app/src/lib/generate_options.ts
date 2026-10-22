import type { Aspect, JobStatus, Quality, StyleId } from '@pictora/core';
import type { RerunSettings } from './images';
import type { PublicModel, PublicStyle } from './models_response';

/** How often the generate screen asks for a job's status, and when it stops asking (GEN-8). */
export const POLL_INTERVAL_MS = 2_000;
export const POLL_TIMEOUT_MS = 3 * 60_000;

/** The style a new form starts with: the prompt as typed, with the model the registry picks for it. */
export const DEFAULT_STYLE: StyleId = 'none';

/** Quality preferred when the chosen model offers it. */
export const DEFAULT_QUALITY: Quality = 'standard';

export const QUALITY_LABELS: Record<Quality, string> = {
  draft: 'Draft',
  standard: 'Standard',
  high: 'High',
};

/** What each job status is called on screen. */
export const STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'Queued',
  running: 'Generating',
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

/** The CSS `aspect-ratio` of an aspect, for its shape icon. */
export function aspectRatioStyle(aspect: Aspect): string {
  return aspect.replace(':', ' / ');
}

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

/** How the generate form starts: empty, or with a gallery image's settings for a rerun (GAL-3). */
export interface InitialForm {
  prompt: string;
  avoid: string;
  styleId: StyleId;
  choices?: ModelChoices;
  transparent: boolean;
  /** The original seed, kept only when the model is the original one and it takes a seed. */
  seed?: number;
  /** The enhanced prompt the original used, reused as is; undefined when it used the user's own words. */
  enhancedPrompt?: string;
  /** True when a rerun's model is no longer available, so another was picked. */
  modelReplaced: boolean;
}

/**
 * The generate form's first state. A rerun keeps the original prompt, avoid text, style, model, aspect, quality,
 * transparency and seed where the model is still available and supports them; otherwise the style's model.
 */
export function initialForm(
  styles: readonly PublicStyle[],
  models: readonly PublicModel[],
  rerun?: RerunSettings,
): InitialForm {
  const styleId = rerun?.style ?? DEFAULT_STYLE;
  const original = rerun && models.find((model) => model.id === rerun.modelId);
  const model = original ?? modelForStyle(styleId, styles, models);
  const choices =
    model &&
    choicesForModel(model, {
      quality: rerun?.quality ?? DEFAULT_QUALITY,
      aspect: rerun?.aspect ?? '1:1',
    });
  return {
    prompt: rerun?.prompt ?? '',
    avoid: model?.capabilities.negativePrompt ? (rerun?.avoid ?? '') : '',
    styleId,
    choices,
    transparent: Boolean(model?.capabilities.transparentBackground && rerun?.transparentBackground),
    ...(original?.capabilities.seed && rerun?.seed !== undefined ? { seed: rerun.seed } : {}),
    ...(rerun?.enhancedPrompt ? { enhancedPrompt: rerun.enhancedPrompt } : {}),
    modelReplaced: rerun !== undefined && !original,
  };
}
