import { modelsForGroups } from '@pictora/core';
import { documentClient, tableName } from './dynamodb';
import type { JobsDeps } from './jobs';
import { modelsResponse, type ModelsResponse } from './models_response';
import { readPremiumPause } from './platform_spend';
import { registryLoader } from './registry';
import type { Session } from './session';

/**
 * The models and styles the user can generate with, as the generate screen and the account page's defaults offer
 * them, with any premium pause from the platform spend cap. Models without a queue in this environment, and the
 * Mock model outside the testers group, would only be refused by `POST /api/jobs`.
 */
export async function generateCatalog(
  deps: Pick<JobsDeps, 'hasQueue' | 'spendCapCents'>,
  session: Session,
): Promise<ModelsResponse> {
  const [enabled, pause] = await Promise.all([
    registryLoader().enabledModels(),
    readPremiumPause(documentClient(), tableName(), deps.spendCapCents, new Date()),
  ]);
  return modelsResponse(
    modelsForGroups(enabled, session.groups).filter((model) => deps.hasQueue(model.provider)),
    pause,
  );
}
