import type { NextRequest } from 'next/server';
import { completeOnboarding } from '../../../../lib/account';
import { accountDeps } from '../../../../lib/account_deps';
import { apiError } from '../../../../lib/jobs';
import { sessionFromHeaders } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

/** Records the user's age confirmation and acceptance of the current terms (AUTH-4). 401 without a session. */
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
  const result = await completeOnboarding(accountDeps(), session, input);
  return Response.json(result.body, {
    status: result.status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
