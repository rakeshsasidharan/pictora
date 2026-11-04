import type { NextRequest } from 'next/server';
import { documentClient, tableName } from '../../../../lib/dynamodb';
import {
  getDefaults,
  resetDefaults,
  saveDefaults,
  type DefaultsDeps,
} from '../../../../lib/generate_defaults';
import type { ApiResult } from '../../../../lib/jobs';
import { readJsonBody } from '../../../../lib/json_body';
import { sessionFromHeaders } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

function deps(): DefaultsDeps {
  return { client: documentClient(), tableName: tableName(), now: () => new Date() };
}

function respond(result: ApiResult): Response {
  return Response.json(result.body, {
    status: result.status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

const unauthorized = () => Response.json({ error: 'Unauthorized' }, { status: 401 });

/** The signed-in user's defaults (GEN-11), or the app defaults. 401 without a session. */
export async function GET(request: NextRequest): Promise<Response> {
  const session = sessionFromHeaders(request.headers);
  if (!session) return unauthorized();
  return respond(await getDefaults(deps(), session));
}

/** Saves the signed-in user's defaults (GEN-11). 401 without a session. */
export async function PUT(request: NextRequest): Promise<Response> {
  const session = sessionFromHeaders(request.headers);
  if (!session) return unauthorized();
  const body = await readJsonBody(request);
  if (!body.ok) return respond(body.error);
  return respond(await saveDefaults(deps(), session, body.value));
}

/** Removes the signed-in user's defaults, so the app defaults apply (GEN-11). 401 without a session. */
export async function DELETE(request: NextRequest): Promise<Response> {
  const session = sessionFromHeaders(request.headers);
  if (!session) return unauthorized();
  return respond(await resetDefaults(deps(), session));
}
