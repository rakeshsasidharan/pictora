import type { NextRequest } from 'next/server';
import { enhancePrompt } from '../../../lib/enhance';
import { enhanceDeps } from '../../../lib/enhance_deps';
import { readJsonBody } from '../../../lib/json_body';
import { sessionFromHeaders } from '../../../lib/session';

export const dynamic = 'force-dynamic';

/** Rewrites a prompt with the enhancer (ENH-1): 200 with `{ enhancedPrompt }`, or a plain-language error. */
export async function POST(request: NextRequest): Promise<Response> {
  const session = sessionFromHeaders(request.headers);
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const body = await readJsonBody(request);
  if (!body.ok) return Response.json(body.error.body, { status: body.error.status });
  const result = await enhancePrompt(enhanceDeps(), session, body.value);
  return Response.json(result.body, { status: result.status });
}
