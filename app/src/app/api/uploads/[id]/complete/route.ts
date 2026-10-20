import type { NextRequest } from 'next/server';
import { sessionFromHeaders } from '../../../../../lib/session';
import { completeUpload } from '../../../../../lib/uploads';
import { uploadsDeps } from '../../../../../lib/uploads_deps';

export const dynamic = 'force-dynamic';

/** Checks and moderates an uploaded file, then makes it a new image (EDIT-2): 201 with the image. */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = sessionFromHeaders(request.headers);
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await context.params;
  const result = await completeUpload(uploadsDeps(), session, id);
  return Response.json(result.body, { status: result.status });
}
