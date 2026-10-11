import type { NextRequest } from 'next/server';
import { sessionFromHeaders } from '../../../lib/session';

export const dynamic = 'force-dynamic';

/** The signed-in user's email and `sub`; 401 without a session. */
export function GET(request: NextRequest): Response {
  const session = sessionFromHeaders(request.headers);
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return Response.json({ sub: session.sub, email: session.email });
}
