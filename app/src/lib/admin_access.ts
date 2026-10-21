import { ADMINS_GROUP } from '@pictora/core';
import type { Session } from './session';

/** The admin pages (ADM-3, ADM-4). */
export const ADMIN_PATH = '/admin';

/** True for `/admin` pages and `/api/admin/*` routes, which only the `admins` group may use. */
export function isAdminPath(pathname: string): boolean {
  return [ADMIN_PATH, '/api/admin'].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** True when the user is in the Cognito `admins` group. */
export function isAdmin(session: Pick<Session, 'groups'>): boolean {
  return session.groups.includes(ADMINS_GROUP);
}
