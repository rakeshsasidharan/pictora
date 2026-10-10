import { z } from 'zod';
import { MAX_IMAGE_COUNT, MIN_IMAGE_COUNT } from './points.js';
import { ASPECTS, MAX_REFERENCE_IMAGES, MODEL_ID_PATTERN, QUALITIES } from './registry.js';
import { STYLE_IDS } from './styles.js';

/** Input limits (GEN-1, tech design section 12). */
export const MAX_PROMPT_LENGTH = 2000;
export const MAX_AVOID_LENGTH = 500;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const UPLOAD_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

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
});

/** `POST /api/jobs` with type `edit` (EDIT-1 to EDIT-5). */
export const editJobRequestSchema = z.strictObject({
  type: z.literal('edit'),
  imageId: ulidSchema,
  parentVersion: z.int().min(1),
  instruction: promptSchema,
  modelId: modelIdSchema,
  quality: qualitySchema,
  /** Uploaded reference images, as `uploads/<sub>/<ulid>` keys. */
  referenceKeys: z
    .array(z.string().regex(/^uploads\/[A-Za-z0-9-]+\/[0-9A-HJKMNP-TV-Z]{26}$/))
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

/** `POST /api/uploads` (EDIT-2). */
export const uploadRequestSchema = z.strictObject({
  contentType: z.enum(UPLOAD_CONTENT_TYPES),
  size: z.int().min(1).max(MAX_UPLOAD_BYTES),
});

export type GenerateJobRequest = z.infer<typeof generateJobRequestSchema>;
export type EditJobRequest = z.infer<typeof editJobRequestSchema>;
export type CreateJobRequest = z.infer<typeof createJobRequestSchema>;
export type EnhanceRequest = z.infer<typeof enhanceRequestSchema>;
export type UploadRequest = z.infer<typeof uploadRequestSchema>;
