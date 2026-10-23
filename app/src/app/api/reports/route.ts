import type { NextRequest } from 'next/server';
import { ulid } from 'ulid';
import { documentClient, tableName } from '../../../lib/dynamodb';
import { readJsonBody } from '../../../lib/json_body';
import { createReport } from '../../../lib/reports';
import { sessionFromHeaders } from '../../../lib/session';

export const dynamic = 'force-dynamic';

/** Reports one of the user's images for review: 201 with the report ID (PRD, Trust and safety). */
export async function POST(request: NextRequest): Promise<Response> {
  const session = sessionFromHeaders(request.headers);
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const body = await readJsonBody(request);
  if (!body.ok) return Response.json(body.error.body, { status: body.error.status });
  const result = await createReport(
    {
      client: documentClient(),
      tableName: tableName(),
      now: () => new Date(),
      newId: () => ulid(),
    },
    session,
    body.value,
  );
  return Response.json(result.body, { status: result.status });
}
