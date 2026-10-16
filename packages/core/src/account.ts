/**
 * The message `DELETE /api/me` sends to the purge queue (AUTH-3). The purge Lambda deletes every item under
 * `USER#<sub>`, the user's S3 objects, then the Cognito user named `username`. `attempt` counts the times the
 * purge put itself back on the queue to wait for the user's running jobs to finish.
 */
export interface PurgeMessage {
  sub: string;
  username: string;
  attempt?: number;
}

const SUB_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const USERNAME_PATTERN = /^[\p{L}\p{M}\p{S}\p{N}\p{P}]{1,128}$/u;

/** Reads a purge message from a queue body; undefined when it isn't one. */
export function parsePurgeMessage(body: string): PurgeMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const { sub, username, attempt } = parsed as Record<string, unknown>;
  if (typeof sub !== 'string' || !SUB_PATTERN.test(sub)) return undefined;
  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) return undefined;
  if (attempt !== undefined && (!Number.isInteger(attempt) || (attempt as number) < 0)) {
    return undefined;
  }
  return { sub, username, ...(attempt === undefined ? {} : { attempt: attempt as number }) };
}

/** The text users type to confirm they want their account deleted. */
export const DELETE_CONFIRMATION = 'DELETE';

/** S3 prefixes holding a user's objects: their images and their uploads (tech design 9). */
export function userObjectPrefixes(sub: string): string[] {
  return [`users/${sub}/`, `uploads/${sub}/`];
}
