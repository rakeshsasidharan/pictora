import { STYLE_PRESETS, type StyleId } from '@pictora/core';
import { QUALITY_LABELS } from './generate_options';
import type { ActiveJobBody, ImageVersionBody } from './images';

/** How long presigned URLs are trusted before a failed image load asks for fresh ones (GAL-4). */
export const URL_REFRESH_AFTER_MS = 30_000;

/**
 * True when URLs fetched at `fetchedAt` (milliseconds) may have expired. A failed load of a newer one is some
 * other problem, and fetching again would only loop.
 */
export function urlsMayHaveExpired(fetchedAt: number, now = Date.now()): boolean {
  return now - fetchedAt >= URL_REFRESH_AFTER_MS;
}

const STYLE_NAMES = new Map(STYLE_PRESETS.map((style) => [style.id, style.name]));

/** For example `15 October 2026 at 12:30 UTC`. */
const CREATED_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

/** One line of the detail view's settings (GAL-2). */
export interface DetailField {
  label: string;
  value: string;
}

/**
 * What the detail view lists for a version (GAL-2): how it was made (prompt, enhanced prompt, or the edit
 * instruction), then the model, style, size, quality, seed and date, each only when the version has it.
 */
export function versionFields(
  version: ImageVersionBody,
  modelNames: Readonly<Record<string, string>>,
): DetailField[] {
  const fields: DetailField[] = [];
  const add = (label: string, value: string | undefined) => {
    if (value !== undefined && value !== '') fields.push({ label, value });
  };
  if (version.editInstruction) {
    add('Edit', version.editInstruction);
    if (version.parentVersion !== undefined) {
      add('Edited from', `Version ${version.parentVersion}`);
    }
  } else if (version.source === 'upload') {
    add('Source', 'Uploaded image');
  } else {
    add('Prompt', version.prompt);
    add('Enhanced prompt', version.enhancedPrompt);
    add('Avoid', version.avoid);
  }
  if (version.modelId) add('Model', modelNames[version.modelId] ?? version.modelId);
  if (version.style && version.style !== 'none') add('Style', styleName(version.style));
  add(
    'Size',
    `${version.width} × ${version.height}${version.aspect ? ` (${version.aspect})` : ''}`,
  );
  if (version.quality) add('Quality', QUALITY_LABELS[version.quality]);
  if (version.transparentBackground) add('Background', 'Transparent');
  if (version.seed !== undefined) add('Seed', String(version.seed));
  if (version.createdAt) add('Created', createdText(version.createdAt));
  return fields;
}

export function styleName(style: StyleId): string {
  return STYLE_NAMES.get(style) ?? style;
}

/** A date for the detail view, in UTC. */
export function createdText(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${CREATED_FORMAT.format(date)} UTC`;
}

/** What a running job's placeholder says (GEN-8). */
export function placeholderText(job: ActiveJobBody): string {
  const state = job.status === 'queued' ? 'Queued' : job.type === 'edit' ? 'Editing' : 'Generating';
  const images =
    job.type === 'edit' ? '' : ` · ${job.count} ${job.count === 1 ? 'image' : 'images'}`;
  return `${state}${images}`;
}
