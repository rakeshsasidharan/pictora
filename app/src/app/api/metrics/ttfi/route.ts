import type { NextRequest } from 'next/server';
import { documentClient, tableName } from '../../../../lib/dynamodb';
import { apiError } from '../../../../lib/jobs';
import { sessionFromHeaders } from '../../../../lib/session';
import { recordTtfi } from '../../../../lib/ttfi';

export const dynamic = 'force-dynamic';

/** Records the signed-in user's time to first image, once (tech design 11.1): 200 with `{ recorded }`. */
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
  const result = await recordTtfi(
    { client: documentClient(), tableName: tableName(), now: () => new Date() },
    session,
    input,
  );
  return Response.json(result.body, { status: result.status });
}
