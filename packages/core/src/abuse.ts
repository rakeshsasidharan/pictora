import { SECONDS_PER_DAY } from './jobs.js';

/** Why an account's allowance was lowered (PRD, Cost control): a disposable email, or many sign-ups from one IP. */
export const ABUSE_FLAGS = ['disposable_email', 'many_accounts'] as const;
export type AbuseFlag = (typeof ABUSE_FLAGS)[number];

/** Daily points for a flagged account, unless an admin set `dailyPoints` (ADM-5 wins). */
export const ABUSE_DAILY_POINTS = 5;

/** Sign-ups from one source IP in a UTC day before further accounts from it are flagged. */
export const SIGN_UPS_PER_IP_PER_DAY = 3;

/** The pre-sign-up marker waits this long for the profile it is copied to; the IP counter, two days. */
export const SIGN_UP_FLAG_TTL_SECONDS = 30 * SECONDS_PER_DAY;
export const SIGN_UP_IP_TTL_SECONDS = 2 * SECONDS_PER_DAY;

export const SIGN_UP_FLAG_SK = 'ABUSE';

export function isAbuseFlag(value: unknown): value is AbuseFlag {
  return (ABUSE_FLAGS as readonly unknown[]).includes(value);
}

/** Emails compare in lower case, as Cognito signs users in (`signInCaseSensitive: false`). */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The `SIGNUP#<email>` / `ABUSE` item the pre-sign-up trigger writes for a flagged email, before the user has a
 * profile (federated users don't have their `sub` yet). The app copies the flag to the profile it creates.
 */
export function signUpFlagPk(email: string): string {
  return `SIGNUP#${normaliseEmail(email)}`;
}

/** The `SIGNUPIP#<date>` / `<ip hash>` counter of sign-ups from one source IP on a UTC day. */
export function signUpIpPk(date: string): string {
  return `SIGNUPIP#${date}`;
}

/** The domain of an email address, in lower case; undefined when it has none. */
export function emailDomain(email: string): string | undefined {
  const at = email.lastIndexOf('@');
  if (at < 0) return undefined;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  return domain === '' ? undefined : domain;
}

/**
 * True when the email's domain, or any parent domain of it, is on the disposable list: `x.mailinator.com` counts
 * as `mailinator.com`. A top-level domain on its own never matches.
 */
export function isDisposableEmail(email: string, disposable: ReadonlySet<string>): boolean {
  const domain = emailDomain(email);
  if (!domain) return false;
  const labels = domain.split('.');
  for (let start = 0; start < labels.length - 1; start++) {
    if (disposable.has(labels.slice(start).join('.'))) return true;
  }
  return false;
}
