import { z } from 'zod';
import { REPORT_REASONS } from './moderation.js';
import { DELIVERIES } from './jobs.js';
import { MAX_IMAGE_COUNT, MIN_IMAGE_COUNT } from './points.js';
import { ASPECTS, MAX_REFERENCE_IMAGES, MODEL_ID_PATTERN, QUALITIES } from './registry.js';
import { STYLE_IDS } from './styles.js';

/** Input limits (GEN-1, tech design section 12). */
export const MAX_PROMPT_LENGTH = 2000;
export const MAX_AVOID_LENGTH = 500;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const UPLOAD_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
/** A presigned upload POST is valid for 5 minutes (EDIT-2). */
export const UPLOAD_POST_EXPIRY_SECONDS = 5 * 60;

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const UPLOAD_REFERENCE_PATTERN = /^uploads\/([A-Za-z0-9_-]+)\/([0-9A-HJKMNP-TV-Z]{26})$/;
const VERSION_REFERENCE_PATTERN =
  /^users\/([A-Za-z0-9_-]+)\/([0-9A-HJKMNP-TV-Z]{26})\/v([1-9][0-9]{0,5})\.png$/;

/** A reference image key, split into the owner's `sub` and what it points at. */
export type ReferenceKey =
  | { kind: 'upload'; sub: string; uploadId: string }
  | { kind: 'version'; sub: string; imageId: string; version: number };

/**
 * Reads a reference image key (EDIT-5): an upload that was never completed, `uploads/<sub>/<ulid>`, or a version
 * of a gallery image, `users/<sub>/<imageId>/v<n>.png`. Undefined for anything else.
 */
export function parseReferenceKey(key: string): ReferenceKey | undefined {
  const upload = UPLOAD_REFERENCE_PATTERN.exec(key);
  if (upload?.[1] && upload[2]) return { kind: 'upload', sub: upload[1], uploadId: upload[2] };
  const version = VERSION_REFERENCE_PATTERN.exec(key);
  if (version?.[1] && version[2] && version[3]) {
    return { kind: 'version', sub: version[1], imageId: version[2], version: Number(version[3]) };
  }
  return undefined;
}

const promptSchema = z.string().trim().min(1).max(MAX_PROMPT_LENGTH);
const modelIdSchema = z.string().max(64).regex(MODEL_ID_PATTERN);
const ulidSchema = z.string().regex(ULID_PATTERN);

export const qualitySchema = z.enum(QUALITIES);
export const aspectSchema = z.enum(ASPECTS);
export const styleIdSchema = z.enum(STYLE_IDS);

/** `POST /api/jobs` with type `generate` (GEN-1 to GEN-9). */
export const generateJobRequestSchema = z.strictObject({
  type: z.literal('generate'),
  prompt: promptSchema,
  /** The enhancer's output, possibly edited by the user (ENH-2). */
  enhancedPrompt: promptSchema.optional(),
  /** Passed as a negative prompt where the model supports one. */
  avoid: z.string().trim().max(MAX_AVOID_LENGTH).optional(),
  style: styleIdSchema,
  modelId: modelIdSchema,
  aspect: aspectSchema,
  quality: qualitySchema,
  count: z.int().min(MIN_IMAGE_COUNT).max(MAX_IMAGE_COUNT),
  seed: z.int().min(0).max(4_294_967_295).optional(),
  transparentBackground: z.boolean().optional(),
  /** `batch` sends the job through a provider batch at half the points, delivered within 24 hours (P1). */
  delivery: z.enum(DELIVERIES).optional(),
});

/** `POST /api/jobs` with type `edit` (EDIT-1 to EDIT-5). */
export const editJobRequestSchema = z.strictObject({
  type: z.literal('edit'),
  imageId: ulidSchema,
  parentVersion: z.int().min(1),
  instruction: promptSchema,
  modelId: modelIdSchema,
  quality: qualitySchema,
  /**
   * Reference images (EDIT-5): raw uploads as `uploads/<sub>/<ulid>`, or gallery image versions as
   * `users/<sub>/<imageId>/v<n>.png` (`parseReferenceKey`).
   */
  referenceKeys: z
    .array(z.string().refine((key) => parseReferenceKey(key) !== undefined))
    .max(MAX_REFERENCE_IMAGES)
    .optional(),
});

export const createJobRequestSchema = z.discriminatedUnion('type', [
  generateJobRequestSchema,
  editJobRequestSchema,
]);

/** `POST /api/enhance` (ENH-1). */
export const enhanceRequestSchema = z.strictObject({
  prompt: promptSchema,
  style: styleIdSchema,
  modelId: modelIdSchema,
});

/** `POST /api/me/onboarding` (AUTH-4): both confirmations, and the terms version the user was shown. */
export const onboardingRequestSchema = z.strictObject({
  ageConfirmed: z.literal(true),
  termsAccepted: z.literal(true),
  tosVersion: z.string().min(1).max(32),
});

/** `POST /api/uploads` (EDIT-2). */
export const uploadRequestSchema = z.strictObject({
  contentType: z.enum(UPLOAD_CONTENT_TYPES),
  size: z.int().min(1).max(MAX_UPLOAD_BYTES),
});

/** `POST /api/reports`: a user reports one of their images (PRD, Trust and safety). */
export const reportRequestSchema = z.strictObject({
  imageId: ulidSchema,
  version: z.int().min(1),
  reason: z.enum(REPORT_REASONS),
});

/** The most characters of alt text a user may set on a version (WCAG 2.2 AA, #30). */
export const MAX_ALT_TEXT_OVERRIDE_LENGTH = 300;

/**
 * `PATCH /api/images/:id/versions/:n`: the user's own alt text for a version, or `null` to go back to the
 * default (the prompt or edit instruction, trimmed to 150 characters).
 */
export const altTextRequestSchema = z.strictObject({
  altText: z.string().trim().min(1).max(MAX_ALT_TEXT_OVERRIDE_LENGTH).nullable(),
});

export type GenerateJobRequest = z.infer<typeof generateJobRequestSchema>;
export type EditJobRequest = z.infer<typeof editJobRequestSchema>;
export type CreateJobRequest = z.infer<typeof createJobRequestSchema>;
export type EnhanceRequest = z.infer<typeof enhanceRequestSchema>;
export type UploadRequest = z.infer<typeof uploadRequestSchema>;
export type OnboardingRequest = z.infer<typeof onboardingRequestSchema>;
export type ReportRequest = z.infer<typeof reportRequestSchema>;
export type AltTextRequest = z.infer<typeof altTextRequestSchema>;
