import type { NextRequest } from 'next/server';
import { apiError } from '../../../../../../../lib/jobs';
import { versionDownloadUrl } from '../../../../../../../lib/images';
import { imagesDeps } from '../../../../../../../lib/images_deps';
import { sessionFromHeaders } from '../../../../../../../lib/session';

export const dynamic = 'force-dynamic';

/**
 * Saves a version's original PNG (GAL-3, GEN-7): a redirect to a presigned URL that answers with
 * `Content-Disposition: attachment`. The link itself never expires, unlike the presigned URL. 404 for anyone else.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string; n: string }> },
): Promise<Response> {
  const session = sessionFromHeaders(request.headers);
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id, n } = await context.params;
  const url = await versionDownloadUrl(imagesDeps(), session, id, n);
  if (!url) {
    const result = apiError('not_found', 'Image not found.');
    return Response.json(result.body, { status: result.status });
  }
  return new Response(null, {
    status: 302,
    headers: { Location: url, 'Cache-Control': 'no-store' },
  });
}
