import type { NextRequest } from 'next/server';
import { apiError } from '../../../lib/jobs';
import { sessionFromHeaders } from '../../../lib/session';
import { createUpload } from '../../../lib/uploads';
import { uploadsDeps } from '../../../lib/uploads_deps';

export const dynamic = 'force-dynamic';

/** Starts an upload (EDIT-2): 200 with a presigned POST for the file, or a plain-language error. */
export async function POST(request: NextRequest): Promise<Response> {
  const session = sessionFromHeaders(request.headers);
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    const result = apiError('invalid_request', 'The request body must be JSON.');
    return Response.json(result.body, { status: result.status });
  }
  const result = await createUpload(uploadsDeps(), session, input);
  return Response.json(result.body, { status: result.status });
}
