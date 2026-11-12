import type { NextRequest } from 'next/server';
import { listTags } from '../../../lib/collections';
import { imagesDeps } from '../../../lib/images_deps';
import { sessionFromHeaders } from '../../../lib/session';

export const dynamic = 'force-dynamic';

/** The caller's tags in use, most used first, for suggestions and the tag filter (tech design 4.2). */
export async function GET(request: NextRequest): Promise<Response> {
  const session = sessionFromHeaders(request.headers);
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const result = await listTags(imagesDeps(), session);
  return Response.json(result.body, {
    status: result.status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
