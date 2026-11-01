import {
  MAX_EMAIL_LENGTH,
  betaAllowlistAddSchema,
  betaEmailSchema,
  betaModeFromEnv,
} from '@pictora/core';
import {
  addToAllowlist,
  listAllowlist,
  removeFromAllowlist,
  type BetaAllowlistEntry,
} from '@pictora/core/beta-store';
import { adminRefusal } from './admin';
import type { AdminDeps } from './admin_stats';
import { apiError, type ApiResult } from './jobs';
import type { Session } from './session';

/** Private beta mode (M4), from `BETA_MODE`, which CDK sets per environment: on in prod for the beta, off in dev. */
export function betaMode(env: Record<string, string | undefined> = process.env): boolean {
  return betaModeFromEnv(env.BETA_MODE);
}

/** The `GET /api/admin/beta/allowlist` body: whether beta mode is on, and every allowlisted email. */
export interface BetaAllowlistBody {
  betaMode: boolean;
  entries: BetaAllowlistEntry[];
}

const INVALID_EMAIL = `Enter a valid email address of at most ${MAX_EMAIL_LENGTH} characters.`;

/** `GET /api/admin/beta/allowlist`: the private beta allowlist, for admins. */
export async function listBetaAllowlist(deps: AdminDeps, session: Session): Promise<ApiResult> {
  const refusal = adminRefusal(session);
  if (refusal) return refusal;
  const body: BetaAllowlistBody = { betaMode: betaMode(), entries: await listAllowlist(deps) };
  return { status: 200, body: { ...body } };
}

/**
 * `POST /api/admin/beta/allowlist` with `{ email }`: puts the email, in lower case, on the allowlist, recording
 * the admin's `sub`. Adding an email already there is safe and keeps its first entry.
 */
export async function addBetaEmail(
  deps: AdminDeps,
  session: Session,
  input: unknown,
): Promise<ApiResult> {
  const refusal = adminRefusal(session);
  if (refusal) return refusal;
  const parsed = betaAllowlistAddSchema.safeParse(input);
  if (!parsed.success) return apiError('invalid_request', INVALID_EMAIL);
  const entry = await addToAllowlist(deps, {
    email: parsed.data.email,
    addedBy: session.sub,
    now: deps.now(),
  });
  return { status: 200, body: { ...entry } };
}

/**
 * `DELETE /api/admin/beta/allowlist/:email`: takes the email off the allowlist. Accounts already created stay;
 * only new sign-ups are checked. 404 when it wasn't on the list.
 */
export async function removeBetaEmail(
  deps: AdminDeps,
  session: Session,
  email: string,
): Promise<ApiResult> {
  const refusal = adminRefusal(session);
  if (refusal) return refusal;
  const parsed = betaEmailSchema.safeParse(decodedParam(email));
  if (!parsed.success) return apiError('invalid_request', INVALID_EMAIL);
  if (!(await removeFromAllowlist(deps, parsed.data))) {
    return apiError('not_found', 'That email isn’t on the allowlist.');
  }
  return { status: 200, body: { email: parsed.data, removed: true } };
}

/** A path parameter, percent-decoded if it still is encoded (`%40` for `@`). */
function decodedParam(value: string): string {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
