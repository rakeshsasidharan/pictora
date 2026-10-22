import type { NextRequest } from 'next/server';
import { createJob } from '../../../lib/jobs';
import { readJsonBody } from '../../../lib/json_body';
import { jobsDeps } from '../../../lib/jobs_deps';
import { sessionFromHeaders } from '../../../lib/session';

export const dynamic = 'force-dynamic';

/** Creates a job: 202 with its ID, or an error with a plain-language message (tech design 7, GEN-10). */
export async function POST(request: NextRequest): Promise<Response> {
  const session = sessionFromHeaders(request.headers);
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const body = await readJsonBody(request);
  if (!body.ok) return Response.json(body.error.body, { status: body.error.status });
  const result = await createJob(jobsDeps(), session, body.value);
  return Response.json(result.body, { status: result.status });
}
