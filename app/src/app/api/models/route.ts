import { modelsResponse } from '../../../lib/models_response';
import { registryLoader } from '../../../lib/registry';

export const dynamic = 'force-dynamic';

/** Registry reads are cached for 60 s, so browsers may reuse the answer as long. */
const CACHE_CONTROL = 'private, max-age=60';

/** The enabled models for this environment, with costs and style presets (tech design 7, GEN-5). */
export async function GET(): Promise<Response> {
  const models = await registryLoader().enabledModels();
  return Response.json(modelsResponse(models), { headers: { 'Cache-Control': CACHE_CONTROL } });
}
