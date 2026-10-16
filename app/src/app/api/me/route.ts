import { NextResponse, type NextRequest } from 'next/server';
import { deleteAccount } from '../../../lib/account';
import { accountDeps } from '../../../lib/account_deps';
import { clearSessionCookies } from '../../../lib/auth_cookies';
import { getMe } from '../../../lib/jobs';
import { jobsDeps } from '../../../lib/jobs_deps';
import { sessionFromHeaders } from '../../../lib/session';

export const dynamic = 'force-dynamic';

/** The signed-in user's profile and today's points; creates the profile on first use. 401 without a session. */
export async function GET(request: NextRequest): Promise<Response> {
  const session = sessionFromHeaders(request.headers);
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const result = await getMe(jobsDeps(), session);
  return Response.json(result.body, {
    status: result.status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

/**
 * Deletes the signed-in user's account (AUTH-3): 202 once deletion has started, with the session cookies
 * cleared so the browser is signed out. The data is purged in the background. 401 without a session.
 */
export async function DELETE(request: NextRequest): Promise<Response> {
  const session = sessionFromHeaders(request.headers);
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const result = await deleteAccount(accountDeps(), session);
  const response = NextResponse.json(result.body, {
    status: result.status,
    headers: { 'Cache-Control': 'no-store' },
  });
  if (result.status === 202) clearSessionCookies(response);
  return response;
}
