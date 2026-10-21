import type { NextRequest } from 'next/server';
import { adminRoute } from '../../../../../lib/admin_route';
import { getAdminUser } from '../../../../../lib/admin_users';

export const dynamic = 'force-dynamic';

/** A user's profile and today's points, for admins (ADM-4). */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ sub: string }> },
): Promise<Response> {
  const { sub } = await context.params;
  return adminRoute(request, (deps, session) => getAdminUser(deps, session, sub));
}
