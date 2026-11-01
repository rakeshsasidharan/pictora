import type { NextRequest } from 'next/server';
import { adminRoute } from '../../../../../lib/admin_route';
import { addBetaEmail, listBetaAllowlist } from '../../../../../lib/beta';
import { readJsonBody } from '../../../../../lib/json_body';

export const dynamic = 'force-dynamic';

/** The private beta allowlist and whether beta mode is on; admins only. */
export async function GET(request: NextRequest): Promise<Response> {
  return adminRoute(request, (deps, session) => listBetaAllowlist(deps, session));
}

/** Adds `{ email }` to the private beta allowlist; admins only. */
export async function POST(request: NextRequest): Promise<Response> {
  return adminRoute(request, async (deps, session) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.error;
    return addBetaEmail(deps, session, body.value);
  });
}
