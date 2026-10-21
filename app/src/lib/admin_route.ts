import type { NextRequest } from 'next/server';
import { adminRefusal } from './admin';
import { adminDeps } from './admin_deps';
import type { AdminDeps } from './admin_stats';
import type { ApiResult } from './jobs';
import { sessionFromHeaders, type Session } from './session';

/**
 * Runs an admin route handler: 401 without a session and 403 outside the `admins` group, both before anything
 * is read, then the handler with the deployed deps. Reads are never cached.
 */
export async function adminRoute(
  request: NextRequest,
  handle: (deps: AdminDeps, session: Session) => Promise<ApiResult>,
): Promise<Response> {
  const session = sessionFromHeaders(request.headers);
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const result = adminRefusal(session) ?? (await handle(adminDeps(), session));
  return Response.json(result.body, {
    status: result.status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
