import { z } from 'zod';
import { REVIEW_VERDICTS } from './moderation.js';

/** The Cognito group whose members can use `/admin` and `/api/admin/*` (tech design 7 and 8). */
export const ADMINS_GROUP = 'admins';

/** The longest date range the stats endpoint covers, and the range it covers by default (ADM-3). */
export const MAX_STATS_RANGE_DAYS = 92;
export const DEFAULT_STATS_RANGE_DAYS = 14;

/** Users listed in the dashboard's top users by points today (ADM-3). */
export const TOP_USERS_LIMIT = 20;

/** The `STATS#<date>` item counting the day's moderation reviews, by the date of the entries reviewed. */
export const STATS_MODERATION_SK = 'MODERATION';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A `yyyy-mm-dd` UTC day that exists in the calendar. */
export const utcDateSchema = z
  .string()
  .regex(DATE_PATTERN)
  .refine((value) => {
    const day = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(day.getTime()) && day.toISOString().startsWith(value);
  });

/** A Cognito `sub`, as used in `USER#<sub>` keys and admin URLs. */
export const userSubSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

/** `GET /api/admin/stats?from=&to=` (ADM-3); both default to a range ending today. */
export const adminStatsQuerySchema = z.strictObject({
  from: utcDateSchema.optional(),
  to: utcDateSchema.optional(),
});

/** `GET /api/admin/moderation?date=` (ADM-4); today when absent. */
export const adminModerationQuerySchema = z.strictObject({ date: utcDateSchema.optional() });

/** `POST /api/admin/moderation/:date/:id/review` (ADM-4). */
export const reviewRequestSchema = z.strictObject({ verdict: z.enum(REVIEW_VERDICTS) });

export type AdminStatsQuery = z.infer<typeof adminStatsQuerySchema>;
export type ReviewRequest = z.infer<typeof reviewRequestSchema>;

/** The UTC days from `from` to `to`, both included, oldest first. */
export function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  const end = new Date(`${to}T00:00:00Z`).getTime();
  for (let day = new Date(`${from}T00:00:00Z`).getTime(); day <= end; day += 86_400_000) {
    dates.push(new Date(day).toISOString().slice(0, 10));
  }
  return dates;
}

/** The UTC day `days` days before `date` (`yyyy-mm-dd`). */
export function daysBefore(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}
