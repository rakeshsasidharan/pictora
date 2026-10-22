import { registryLoader } from './registry';

/**
 * Display names of every model in the registry, switched-off ones included, so the detail view can name the
 * model an older image was made with (GAL-2).
 */
export async function modelNames(): Promise<Record<string, string>> {
  const models = await registryLoader().models();
  return Object.fromEntries(models.map((model) => [model.id, model.displayName]));
}
