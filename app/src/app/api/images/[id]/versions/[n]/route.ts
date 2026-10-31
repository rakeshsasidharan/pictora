import type { NextRequest } from 'next/server';
import { setVersionAltText } from '../../../../../../lib/images';
import { imagesDeps } from '../../../../../../lib/images_deps';
import { readJsonBody } from '../../../../../../lib/json_body';
import { sessionFromHeaders } from '../../../../../../lib/session';

export const dynamic = 'force-dynamic';

/** Sets or clears the user's own alt text on one of their versions (#30); 404 for anyone else. */
export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string; n: string }> },
): Promise<Response> {
  const session = sessionFromHeaders(request.headers);
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const body = await readJsonBody(request);
  if (!body.ok) return Response.json(body.error.body, { status: body.error.status });
  const { id, n } = await context.params;
  const result = await setVersionAltText(imagesDeps(), session, id, n, body.value);
  return Response.json(result.body, { status: result.status });
}
