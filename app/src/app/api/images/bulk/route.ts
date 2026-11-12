import type { NextRequest } from 'next/server';
import { bulkUpdate } from '../../../../lib/collections';
import { imagesDeps } from '../../../../lib/images_deps';
import { readJsonBody } from '../../../../lib/json_body';
import { sessionFromHeaders } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

/**
 * Moves, tags, untags or deletes up to 50 of the caller's images, reporting each one (tech design 4.2). Images
 * the caller doesn't have are reported `not_found` and left alone.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const session = sessionFromHeaders(request.headers);
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const body = await readJsonBody(request);
  if (!body.ok) return Response.json(body.error.body, { status: body.error.status });
  const result = await bulkUpdate(imagesDeps(), session, body.value);
  return Response.json(result.body, { status: result.status });
}
