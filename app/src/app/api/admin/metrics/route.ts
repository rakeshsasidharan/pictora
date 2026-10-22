import type { NextRequest } from 'next/server';
import { getAdminMetrics } from '../../../../lib/admin_metrics';
import { adminRoute } from '../../../../lib/admin_route';

export const dynamic = 'force-dynamic';

/** The PRD's success metrics against their targets, per day and over the range; 403 for anyone but admins. */
export async function GET(request: NextRequest): Promise<Response> {
  const query = Object.fromEntries(request.nextUrl.searchParams);
  return adminRoute(request, (deps, session) => getAdminMetrics(deps, session, query));
}
