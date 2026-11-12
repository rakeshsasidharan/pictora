import type { NextRequest } from 'next/server';
import { deleteCollection, renameCollection } from '../../../../lib/collections';
import { imagesDeps } from '../../../../lib/images_deps';
import { readJsonBody } from '../../../../lib/json_body';
import { sessionFromHeaders } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** Renames the caller's collection; 404 for anyone else's. */
export async function PATCH(request: NextRequest, context: Context): Promise<Response> {
  const session = sessionFromHeaders(request.headers);
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const body = await readJsonBody(request);
  if (!body.ok) return Response.json(body.error.body, { status: body.error.status });
  const { id } = await context.params;
  const result = await renameCollection(imagesDeps(), session, id, body.value);
  return Response.json(result.body, { status: result.status });
}

/** Deletes the caller's collection; its images stay in the gallery. 404 for anyone else's. */
export async function DELETE(request: NextRequest, context: Context): Promise<Response> {
  const session = sessionFromHeaders(request.headers);
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await context.params;
  const result = await deleteCollection(imagesDeps(), session, id);
  return Response.json(result.body, { status: result.status });
}
