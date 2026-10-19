import { documentClient, tableName } from '../../../lib/dynamodb';
import { modelsResponse } from '../../../lib/models_response';
import { readPremiumPause, spendCapCents } from '../../../lib/platform_spend';
import { registryLoader } from '../../../lib/registry';

export const dynamic = 'force-dynamic';

/** Registry reads are cached for 60 s, so browsers may reuse the answer as long. */
const CACHE_CONTROL = 'private, max-age=60';

/**
 * The enabled models for this environment, with costs and style presets (tech design 7, GEN-5). Once the month's
 * platform spend reaches the cap, premium qualities are marked paused.
 */
export async function GET(): Promise<Response> {
  const [models, pause] = await Promise.all([
    registryLoader().enabledModels(),
    readPremiumPause(documentClient(), tableName(), spendCapCents(), new Date()),
  ]);
  return Response.json(modelsResponse(models, pause), {
    headers: { 'Cache-Control': CACHE_CONTROL },
  });
}
