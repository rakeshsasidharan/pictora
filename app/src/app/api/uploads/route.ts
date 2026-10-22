import type { NextRequest } from 'next/server';
import { readJsonBody } from '../../../lib/json_body';
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
  const body = await readJsonBody(request);
  if (!body.ok) return Response.json(body.error.body, { status: body.error.status });
  const result = await createUpload(uploadsDeps(), session, body.value);
  return Response.json(result.body, { status: result.status });
}
