import type { NextRequest } from 'next/server';
import { documentClient, tableName } from '../../../../lib/dynamodb';
import { readJsonBody } from '../../../../lib/json_body';
import { sessionFromHeaders } from '../../../../lib/session';
import { recordTtfi } from '../../../../lib/ttfi';

export const dynamic = 'force-dynamic';

/** Records the signed-in user's time to first image, once (tech design 11.1): 200 with `{ recorded }`. */
export async function POST(request: NextRequest): Promise<Response> {
  const session = sessionFromHeaders(request.headers);
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const body = await readJsonBody(request);
  if (!body.ok) return Response.json(body.error.body, { status: body.error.status });
  const result = await recordTtfi(
    { client: documentClient(), tableName: tableName(), now: () => new Date() },
    session,
    body.value,
  );
  return Response.json(result.body, { status: result.status });
}
