import type { NextRequest } from 'next/server';
import { apiError, createJob } from '../../../lib/jobs';
import { jobsDeps } from '../../../lib/jobs_deps';
import { sessionFromHeaders } from '../../../lib/session';

export const dynamic = 'force-dynamic';

/** Creates a job: 202 with its ID, or an error with a plain-language message (tech design 7, GEN-10). */
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
  const result = await createJob(jobsDeps(), session, input);
  return Response.json(result.body, { status: result.status });
}
