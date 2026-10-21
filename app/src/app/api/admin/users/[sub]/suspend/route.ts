import type { NextRequest } from 'next/server';
import { adminRoute } from '../../../../../../lib/admin_route';
import { setSuspension } from '../../../../../../lib/admin_users';

export const dynamic = 'force-dynamic';

/** Suspends a user, so their job and enhance requests answer 403 (ADM-4); admins only. */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ sub: string }> },
): Promise<Response> {
  const { sub } = await context.params;
  return adminRoute(request, (deps, session) => setSuspension(deps, session, sub, 'suspend'));
}
