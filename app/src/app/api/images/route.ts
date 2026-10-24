import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { GALLERY_MAX_LIMIT, listImages } from '../../../lib/images';
import { imagesDeps } from '../../../lib/images_deps';
import { apiError } from '../../../lib/jobs';
import { sessionFromHeaders } from '../../../lib/session';

export const dynamic = 'force-dynamic';

/** `?limit=`: a whole number of images from 1 to 50. */
const limitSchema = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(GALLERY_MAX_LIMIT));

/**
 * A page of the caller's gallery, newest first, with their running jobs on the first page (GAL-1, GEN-8).
 * `?limit=` asks for a smaller or larger page, as the sidebar history does.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const session = sessionFromHeaders(request.headers);
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const searchParams = request.nextUrl.searchParams;
  const limitParam = searchParams.get('limit');
  const limit = limitParam === null ? undefined : limitSchema.safeParse(limitParam);
  const result =
    limit && !limit.success
      ? apiError(
          'invalid_request',
          `The number of images must be a whole number from 1 to ${GALLERY_MAX_LIMIT}.`,
        )
      : await listImages(imagesDeps(), session, searchParams.get('cursor'), limit?.data);
  return Response.json(result.body, {
    status: result.status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
