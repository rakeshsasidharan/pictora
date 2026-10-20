import type { NextRequest } from 'next/server';
import { listModeration } from '../../../../lib/admin_moderation';
import { adminRoute } from '../../../../lib/admin_route';

export const dynamic = 'force-dynamic';

/** The day's blocks and reports for review (ADM-4); 403 for anyone but admins. */
export async function GET(request: NextRequest): Promise<Response> {
  const query = Object.fromEntries(request.nextUrl.searchParams);
  return adminRoute(request, (deps, session) => listModeration(deps, session, query));
}
