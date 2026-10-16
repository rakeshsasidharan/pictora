import type { NextRequest } from 'next/server';
import { getJobStatus } from '../../../../lib/jobs';
import { jobsDeps } from '../../../../lib/jobs_deps';
import { sessionFromHeaders } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

/** The job's status, error and images, for its owner only (tech design 7). */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = sessionFromHeaders(request.headers);
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await context.params;
  const result = await getJobStatus(jobsDeps(), session, id);
  return Response.json(result.body, {
    status: result.status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
