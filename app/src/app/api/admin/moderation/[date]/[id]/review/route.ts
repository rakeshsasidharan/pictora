import type { NextRequest } from 'next/server';
import { reviewEntry } from '../../../../../../../lib/admin_moderation';
import { adminRoute } from '../../../../../../../lib/admin_route';
import { readJsonBody } from '../../../../../../../lib/json_body';

export const dynamic = 'force-dynamic';

/** Marks a block or report `ok` or `confirmed` (ADM-4); 403 for anyone but admins. */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ date: string; id: string }> },
): Promise<Response> {
  const { date, id } = await context.params;
  return adminRoute(request, async (deps, session) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.error;
    return reviewEntry(deps, session, date, id, body.value);
  });
}
