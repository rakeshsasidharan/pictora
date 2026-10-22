import type { NextRequest } from 'next/server';
import { completeOnboarding } from '../../../../lib/account';
import { accountDeps } from '../../../../lib/account_deps';
import { readJsonBody } from '../../../../lib/json_body';
import { sessionFromHeaders } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

/** Records the user's age confirmation and acceptance of the current terms (AUTH-4). 401 without a session. */
export async function POST(request: NextRequest): Promise<Response> {
  const session = sessionFromHeaders(request.headers);
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const body = await readJsonBody(request);
  if (!body.ok) return Response.json(body.error.body, { status: body.error.status });
  const result = await completeOnboarding(accountDeps(), session, body.value);
  return Response.json(result.body, {
    status: result.status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
