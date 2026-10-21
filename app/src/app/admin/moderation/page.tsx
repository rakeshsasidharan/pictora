import { utcDate } from '@pictora/core';
import { ModerationReview } from '../../../components/moderation_review';

export const dynamic = 'force-dynamic';

/** Blocks and reports to review (ADM-4), starting with today's. */
export default function ModerationPage() {
  return <ModerationReview initialDate={utcDate(new Date())} />;
}
