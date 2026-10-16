import type { NextRequest } from 'next/server';
import { getMe } from '../../../lib/jobs';
import { jobsDeps } from '../../../lib/jobs_deps';
import { sessionFromHeaders } from '../../../lib/session';

export const dynamic = 'force-dynamic';

/** The signed-in user's profile and today's points; creates the profile on first use. 401 without a session. */
export async function GET(request: NextRequest): Promise<Response> {
  const session = sessionFromHeaders(request.headers);
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const result = await getMe(jobsDeps(), session);
  return Response.json(result.body, {
    status: result.status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
