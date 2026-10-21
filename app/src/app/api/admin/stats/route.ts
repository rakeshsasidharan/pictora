import type { NextRequest } from 'next/server';
import { adminRoute } from '../../../../lib/admin_route';
import { getAdminStats } from '../../../../lib/admin_stats';

export const dynamic = 'force-dynamic';

/** Spend, usage and top users for admins (ADM-3); 403 for anyone else. */
export async function GET(request: NextRequest): Promise<Response> {
  const query = Object.fromEntries(request.nextUrl.searchParams);
  return adminRoute(request, (deps, session) => getAdminStats(deps, session, query));
}
