import { galleryFilterSchema } from '@pictora/core';
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
 * `?limit=` asks for a smaller or larger page, as the sidebar history does. `?q=`, `?tag=` and `?collection=`
 * search and filter it (tech design 4.2).
 */
export async function GET(request: NextRequest): Promise<Response> {
  const session = sessionFromHeaders(request.headers);
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const searchParams = request.nextUrl.searchParams;
  const limitParam = searchParams.get('limit');
  const limit = limitParam === null ? undefined : limitSchema.safeParse(limitParam);
  const filter = galleryFilterSchema.safeParse({
    q: searchParams.get('q') || undefined,
    tag: searchParams.get('tag') || undefined,
    collection: searchParams.get('collection') || undefined,
  });
  const result =
    limit && !limit.success
      ? apiError(
          'invalid_request',
          `The number of images must be a whole number from 1 to ${GALLERY_MAX_LIMIT}.`,
        )
      : !filter.success
        ? apiError('invalid_request', 'That search or filter is not valid.')
        : await listImages(
            imagesDeps(),
            session,
            searchParams.get('cursor'),
            limit?.data,
            filter.data,
          );
  return Response.json(result.body, {
    status: result.status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
