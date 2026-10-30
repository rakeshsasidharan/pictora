import type { JobStatus } from '@pictora/core';
import { pointsText } from './generate_options';

/** What a job's live region says as it moves along. */
export interface JobAnnouncementInput {
  status: JobStatus;
  /** How many images the finished job made. */
  images?: number;
  /** Said once the job is done, in place of how many images are ready. */
  readyText?: string;
  /** Why it failed or was blocked. */
  error?: string;
  /** Points given back after a failure. */
  refunded?: number;
}

/**
 * The words a screen reader hears when a job changes status (WCAG 2.2 AA, #30): "Queued…", "Generating…",
 * "2 images ready", or why it failed and what was refunded. Sent to a polite live region, so each change is
 * read once without moving the focus.
 */
export function jobAnnouncement({
  status,
  images = 1,
  readyText,
  error,
  refunded = 0,
}: JobAnnouncementInput): string {
  switch (status) {
    case 'queued':
      return 'Queued…';
    case 'running':
      return 'Generating…';
    case 'scheduled':
    case 'submitted':
      return 'Scheduled. Your images will be in your gallery within 24 hours.';
    case 'succeeded':
      return readyText ?? `${images} ${images === 1 ? 'image' : 'images'} ready`;
    case 'failed':
    case 'blocked': {
      const reason = error ?? 'Something went wrong.';
      return refunded > 0 ? `${reason} ${pointsText(refunded)} returned.` : reason;
    }
  }
}
