import { z } from 'zod';
import { normaliseEmail } from './abuse.js';

/**
 * The private beta allowlist (PRD, M4 Private beta; tech design 8): while beta mode is on, only these emails can
 * sign up. Each is a `BETA#ALLOWLIST` / `<email in lower case>` item, so the whole list is one Query.
 */
export const BETA_ALLOWLIST_PK = 'BETA#ALLOWLIST';

/** The allowlist item's sort key: the email in lower case, as Cognito compares it. */
export function betaAllowlistSk(email: string): string {
  return normaliseEmail(email);
}

/**
 * What the pre-sign-up trigger answers an email that isn't on the allowlist. Cognito shows it on the managed
 * login page, and passes it back to the app's callback for a Google sign-up, where `isBetaRejection` spots it.
 */
export const BETA_REJECTION_MESSAGE =
  'Pictora is in private beta. Sign-ups are by invitation only for now.';

/** The words the app looks for in Cognito's error description, which wraps the trigger's message. */
const BETA_REJECTION_MARKER = 'Pictora is in private beta';

/** True when an OAuth `error_description` from Cognito is the pre-sign-up trigger's beta rejection. */
export function isBetaRejection(errorDescription: string | null | undefined): boolean {
  return Boolean(errorDescription?.includes(BETA_REJECTION_MARKER));
}

/** `BETA_MODE` as CDK sets it on the app and the pre-sign-up trigger: `true` turns the allowlist on. */
export function betaModeFromEnv(value: string | undefined): boolean {
  return value === 'true';
}

/** The longest email address SMTP allows. */
export const MAX_EMAIL_LENGTH = 254;

/** An email to add to the allowlist: trimmed, lower-cased and checked. */
export const betaEmailSchema = z
  .string()
  .trim()
  .max(MAX_EMAIL_LENGTH)
  .pipe(z.email())
  .transform((email) => normaliseEmail(email));

/** `POST /api/admin/beta/allowlist`. */
export const betaAllowlistAddSchema = z.strictObject({ email: betaEmailSchema });
export type BetaAllowlistAdd = z.infer<typeof betaAllowlistAddSchema>;

/** One allowlist item as stored. `addedBy` is the admin's `sub`, or `cli` for an email added by hand. */
export interface BetaAllowlistItem {
  PK: typeof BETA_ALLOWLIST_PK;
  SK: string;
  email: string;
  addedAt: string;
  addedBy: string;
}
