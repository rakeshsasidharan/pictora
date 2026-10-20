import { SECONDS_PER_DAY } from './jobs.js';

/** Categories the OpenAI moderation endpoint (`omni-moderation-latest`) reports (tech design 6.3). */
export const MODERATION_CATEGORIES = [
  'sexual',
  'sexual/minors',
  'harassment',
  'harassment/threatening',
  'hate',
  'hate/threatening',
  'illicit',
  'illicit/violent',
  'self-harm',
  'self-harm/intent',
  'self-harm/instructions',
  'violence',
  'violence/graphic',
] as const;
export type ModerationCategory = (typeof MODERATION_CATEGORIES)[number];

/**
 * Categories Pictora blocks (PRD, Trust and safety), most serious first, so a request flagged for several is
 * logged under the worst. Sexual content involving minors and sexual content in general are always blocked.
 * Plain `violence` and `harassment` are allowed: the policy blocks graphic violence and threats, not a
 * knight fighting a dragon or a grumpy cat.
 */
export const BLOCKED_CATEGORIES: readonly ModerationCategory[] = [
  'sexual/minors',
  'sexual',
  'violence/graphic',
  'hate/threatening',
  'hate',
  'harassment/threatening',
  'self-harm/instructions',
  'self-harm/intent',
  'self-harm',
  'illicit/violent',
  'illicit',
];

/** Categories that block whatever else the endpoint says. */
export const ALWAYS_BLOCKED_CATEGORIES: readonly ModerationCategory[] = ['sexual/minors', 'sexual'];

/** The moderation endpoint's answer: whether it flagged the input, and the flag per category. */
export interface ModerationResult {
  flagged: boolean;
  categories: Partial<Record<string, boolean>>;
}

/**
 * The category that blocks a request under Pictora's policy, or undefined when it may go ahead. A flag on a
 * category the policy allows doesn't block.
 */
export function blockingCategory(result: ModerationResult): ModerationCategory | undefined {
  return BLOCKED_CATEGORIES.find((category) => result.categories[category] === true);
}

/** Where in the pipeline a request was blocked. */
export const BLOCK_STAGES = ['prompt', 'image', 'provider'] as const;
export type BlockStage = (typeof BLOCK_STAGES)[number];

/** The category logged when the provider refused a request itself. */
export const PROVIDER_REFUSAL_CATEGORY = 'provider_refusal';

/** Blocks in the last 24 hours that cool an account down, and for how long (PRD, Trust and safety). */
export const COOLDOWN_BLOCKS = 3;
export const BLOCK_WINDOW_MS = 24 * 60 * 60_000;
export const COOLDOWN_MS = 24 * 60 * 60_000;

/** Item lifetimes (tech design 4). */
export const BLOCK_TTL_SECONDS = SECONDS_PER_DAY;
export const MODLOG_TTL_DAYS = 90;

/** Most characters of a prompt kept in a moderation log entry. */
export const PROMPT_EXCERPT_LENGTH = 200;

/** Reasons a user can give when reporting an output (`POST /api/reports`). */
export const REPORT_REASONS = [
  'sexual',
  'violence',
  'hate',
  'self-harm',
  'illegal',
  'real-person',
  'other',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export function blockSk(blockId: string): string {
  return `BLOCK#${blockId}`;
}

export function modlogPk(date: string): string {
  return `MODLOG#${date}`;
}

/** The start of a prompt, on one line, for a moderation log entry. */
export function promptExcerpt(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim().slice(0, PROMPT_EXCERPT_LENGTH);
}

/**
 * The `USER#<sub>` / `BLOCK#<ulid>` item, kept for 24 hours to count recent blocks. A blocked job carries its
 * `jobId`; a blocked upload (EDIT-2), which has no job, carries its `uploadId`.
 */
export interface BlockItem {
  PK: string;
  SK: string;
  stage: BlockStage;
  category: string;
  jobId?: string;
  uploadId?: string;
  createdAt: string;
  ttl: number;
}

/** A `MODLOG#<date>` / `<ulid>` item: a block or a user's report, kept for 90 days for review. */
export type ModlogItem = {
  PK: string;
  SK: string;
  userId: string;
  createdAt: string;
  ttl: number;
} & (
  | {
      type: 'block';
      stage: BlockStage;
      category: string;
      promptExcerpt: string;
      /** A blocked job's model; a blocked upload has none. */
      provider?: string;
      modelId?: string;
      jobId?: string;
      uploadId?: string;
    }
  | {
      type: 'report';
      reason: ReportReason;
      imageId: string;
      version: number;
      s3Key: string;
      promptExcerpt: string;
      /** The version's model; an uploaded image has none. */
      modelId?: string;
    }
);
