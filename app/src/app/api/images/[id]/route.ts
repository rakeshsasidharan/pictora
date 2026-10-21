import type { NextRequest } from 'next/server';
import { getImageDetail } from '../../../../lib/images';
import { jobsDeps } from '../../../../lib/jobs_deps';
import { sessionFromHeaders } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

/** The caller's image with every version and presigned URLs (tech design 7); 404 for anyone else. */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = sessionFromHeaders(request.headers);
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await context.params;
  const result = await getImageDetail(jobsDeps(), session, id);
  return Response.json(result.body, {
    status: result.status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
