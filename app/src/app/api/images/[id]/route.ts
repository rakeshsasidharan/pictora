import type { NextRequest } from 'next/server';
import { deleteImage, getImageDetail } from '../../../../lib/images';
import { imagesDeps } from '../../../../lib/images_deps';
import { sessionFromHeaders } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** The caller's image with every version and presigned URLs (tech design 7); 404 for anyone else. */
export async function GET(request: NextRequest, context: Context): Promise<Response> {
  const session = sessionFromHeaders(request.headers);
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await context.params;
  const result = await getImageDetail(imagesDeps(), session, id);
  return Response.json(result.body, {
    status: result.status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

/** Deletes the caller's image, every version and every object (GAL-3); 404 for anyone else. */
export async function DELETE(request: NextRequest, context: Context): Promise<Response> {
  const session = sessionFromHeaders(request.headers);
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await context.params;
  const result = await deleteImage(imagesDeps(), session, id);
  return Response.json(result.body, { status: result.status });
}
