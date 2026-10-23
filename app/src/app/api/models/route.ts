import { modelsForGroups } from '@pictora/core';
import type { NextRequest } from 'next/server';
import { documentClient, tableName } from '../../../lib/dynamodb';
import { modelsResponse } from '../../../lib/models_response';
import { readPremiumPause, spendCapCents } from '../../../lib/platform_spend';
import { registryLoader } from '../../../lib/registry';
import { sessionFromHeaders } from '../../../lib/session';

export const dynamic = 'force-dynamic';

/** Registry reads are cached for 60 s, so browsers may reuse the answer as long. */
const CACHE_CONTROL = 'private, max-age=60';

/**
 * The enabled models for this environment, with costs and style presets (tech design 7, GEN-5). The Mock model
 * is listed for the testers group only. Once the month's platform spend reaches the cap, premium qualities are
 * marked paused. 401 without a session.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const session = sessionFromHeaders(request.headers);
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const [models, pause] = await Promise.all([
    registryLoader().enabledModels(),
    readPremiumPause(documentClient(), tableName(), spendCapCents(), new Date()),
  ]);
  return Response.json(modelsResponse(modelsForGroups(models, session.groups), pause), {
    headers: { 'Cache-Control': CACHE_CONTROL },
  });
}
