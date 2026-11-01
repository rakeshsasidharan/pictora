import type { NextRequest } from 'next/server';
import { adminRoute } from '../../../../../../lib/admin_route';
import { removeBetaEmail } from '../../../../../../lib/beta';

export const dynamic = 'force-dynamic';

/** Takes an email off the private beta allowlist; admins only. */
export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ email: string }> },
): Promise<Response> {
  const { email } = await context.params;
  return adminRoute(request, (deps, session) => removeBetaEmail(deps, session, email));
}
