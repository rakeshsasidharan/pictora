import type { NextRequest } from 'next/server';
import { listImages } from '../../../lib/images';
import { imagesDeps } from '../../../lib/images_deps';
import { sessionFromHeaders } from '../../../lib/session';

export const dynamic = 'force-dynamic';

/** A page of the caller's gallery, newest first, with their running jobs on the first page (GAL-1, GEN-8). */
export async function GET(request: NextRequest): Promise<Response> {
  const session = sessionFromHeaders(request.headers);
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const result = await listImages(
    imagesDeps(),
    session,
    request.nextUrl.searchParams.get('cursor'),
  );
  return Response.json(result.body, {
    status: result.status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
