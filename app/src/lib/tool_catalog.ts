import {
  TOOL_IDS,
  TOOL_NAMES,
  modelsForGroups,
  pickToolModel,
  toolCostPoints,
  type ModelConfig,
  type PremiumPause,
  type Provider,
  type ToolId,
} from '@pictora/core';
import { documentClient, tableName } from './dynamodb';
import type { JobsDeps } from './jobs';
import { readPremiumPause } from './platform_spend';
import { registryLoader } from './registry';
import type { Session } from './session';

/** An image tool as the image view offers it (tech design 5.5): its name and what one run costs. */
export interface PublicTool {
  id: ToolId;
  name: string;
  costPoints: number;
}

/** The image tools the user can run now, and, while the platform spend cap pauses them, until when. */
export interface ToolCatalog {
  tools: PublicTool[];
  /** ISO 8601 UTC; set while the tools are paused with the premium qualities (tech design 4.1). */
  pausedUntil?: string;
}

/**
 * The tools a user can run, in `TOOL_IDS` order, each priced on the model `POST /api/jobs` would pick for it
 * (`pickToolModel`): enabled models with a queue only, and the Mock for the testers group only.
 */
export function toolsFor(
  models: readonly ModelConfig[],
  groups: readonly string[],
  hasQueue: (provider: Provider) => boolean,
  pause?: PremiumPause,
): ToolCatalog {
  const available = modelsForGroups(models, groups).filter(
    (model) => model.enabled && hasQueue(model.provider),
  );
  const tools = TOOL_IDS.flatMap((id) => {
    const model = pickToolModel(available, id, groups);
    const costPoints = model && toolCostPoints(model, id);
    return costPoints === undefined ? [] : [{ id, name: TOOL_NAMES[id], costPoints }];
  });
  return { tools, ...(pause ? { pausedUntil: pause.until.toISOString() } : {}) };
}

/** The tool catalogue for the signed-in user, as the gallery pages read it on the server. */
export async function toolCatalog(
  deps: Pick<JobsDeps, 'hasQueue' | 'spendCapCents'>,
  session: Session,
): Promise<ToolCatalog> {
  const [enabled, pause] = await Promise.all([
    registryLoader().enabledModels(),
    readPremiumPause(documentClient(), tableName(), deps.spendCapCents, new Date()),
  ]);
  return toolsFor(enabled, session.groups, deps.hasQueue, pause);
}
