import { DEFAULT_EDIT_MODEL_ID, MAX_REFERENCE_IMAGES, type Quality } from '@pictora/core';
import { DEFAULT_QUALITY, altTextFor } from './generate_options';
import type { ImageVersionBody } from './images';
import type { PublicModel } from './models_response';

/** Models that can edit images, in registry order (EDIT-4). */
export function editModels(models: readonly PublicModel[]): PublicModel[] {
  return models.filter((model) => model.capabilities.edit);
}

/** The model the edit panel starts with: Gemini 3.1 Flash Image when it is available, else the first. */
export function defaultEditModel(models: readonly PublicModel[]): PublicModel | undefined {
  return models.find((model) => model.id === DEFAULT_EDIT_MODEL_ID) ?? models[0];
}

/**
 * The quality to use with a newly chosen edit model: the current one when it offers it and it isn't paused,
 * otherwise Standard or the model's first quality that isn't paused.
 */
export function editQualityFor(model: PublicModel, current: Quality): Quality {
  const usable = model.qualities.filter((option) => !option.paused).map((option) => option.quality);
  const offered = usable.length > 0 ? usable : model.qualities.map((option) => option.quality);
  if (offered.includes(current)) return current;
  if (offered.includes(DEFAULT_QUALITY)) return DEFAULT_QUALITY;
  return offered[0] ?? current;
}

/** How many reference images the model takes (EDIT-5); 0 hides the references. */
export function maxReferences(model: PublicModel): number {
  return Math.min(MAX_REFERENCE_IMAGES, model.capabilities.referenceImages);
}

/** What a version is, in the version list: the edit instruction, or how the original was made. */
export function versionDescription(version: ImageVersionBody): string {
  if (version.editInstruction) return version.editInstruction;
  if (version.source === 'upload') return 'Uploaded image';
  return version.prompt ?? 'Original image';
}

/** A version's default alt text: what it was made or edited with, trimmed to 150 characters. */
export function defaultAltText(version: ImageVersionBody): string {
  return altTextFor(versionDescription(version));
}

/** The alt text of a version: the user's own, set in the detail view, or the default. */
export function versionAltText(version: ImageVersionBody): string {
  return version.altText ?? defaultAltText(version);
}
