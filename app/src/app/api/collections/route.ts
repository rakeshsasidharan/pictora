import type { NextRequest } from 'next/server';
import { createCollection, listCollections } from '../../../lib/collections';
import { imagesDeps } from '../../../lib/images_deps';
import { readJsonBody } from '../../../lib/json_body';
import { sessionFromHeaders } from '../../../lib/session';

export const dynamic = 'force-dynamic';

/** The caller's collections, by name (tech design 4.2). */
export async function GET(request: NextRequest): Promise<Response> {
  const session = sessionFromHeaders(request.headers);
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const result = await listCollections(imagesDeps(), session);
  return Response.json(result.body, {
    status: result.status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

/** Creates an empty collection with a name the caller doesn't already use. */
export async function POST(request: NextRequest): Promise<Response> {
  const session = sessionFromHeaders(request.headers);
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const body = await readJsonBody(request);
  if (!body.ok) return Response.json(body.error.body, { status: body.error.status });
  const result = await createCollection(imagesDeps(), session, body.value);
  return Response.json(result.body, { status: result.status });
}
