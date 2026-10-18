import type { NextRequest } from 'next/server';
import { enhancePrompt } from '../../../lib/enhance';
import { enhanceDeps } from '../../../lib/enhance_deps';
import { apiError } from '../../../lib/jobs';
import { sessionFromHeaders } from '../../../lib/session';

export const dynamic = 'force-dynamic';

/** Rewrites a prompt with the enhancer (ENH-1): 200 with `{ enhancedPrompt }`, or a plain-language error. */
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
  const result = await enhancePrompt(enhanceDeps(), session, input);
  return Response.json(result.body, { status: result.status });
}
