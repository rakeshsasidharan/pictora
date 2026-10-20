import type { ModelConfig, Provider } from '@pictora/core';
import { powertoolsMetrics, type EmitMetrics } from '@pictora/core/observability';
import { createRegistryLoader, dynamoRegistrySource } from '@pictora/core/registry-store';
import {
  bedrockModelCatalogue,
  geminiModelCatalogue,
  geminiConfigFromEnv,
  openAiModelCatalogue,
  secretApiKey,
  secretString,
  type ModelCatalogue,
} from '@pictora/providers';
import { tableContext, workerEnvironment } from './deps.js';
import { log } from './log.js';

/** A retirement this close counts as a problem, so there is time to switch models (PRD, Risks). */
export const EOL_WARNING_DAYS = 60;
const DAY_MS = 24 * 60 * 60_000;

/** Why a model needs attention. */
export type ModelProblemReason = 'missing' | 'deprecated' | 'retiring';

export interface ModelProblem {
  modelId: string;
  provider: Provider;
  providerModelId: string;
  reason: ModelProblemReason;
  /** For `retiring`: the end-of-life date, `yyyy-mm-dd`. */
  eolDate?: string;
}

export interface ModelHealthReport {
  checked: string[];
  problems: ModelProblem[];
  /** Providers whose models list couldn't be read. Their models are neither passed nor flagged. */
  unavailable: Provider[];
}

/** Each provider's models list. A provider without one (the dev-only mock) isn't checked. */
export type Catalogues = Partial<Record<Provider, () => Promise<ModelCatalogue>>>;

/**
 * Checks each enabled model against its provider's models list (tech design 3.2): it must still be listed,
 * not marked legacy, and not retire within 60 days, by the registry's `eolDate` or the provider's own date.
 * A provider whose list can't be read is reported as unavailable and none of its models are flagged, so an
 * outage doesn't raise a false alarm.
 */
export async function checkModelHealth(
  models: readonly ModelConfig[],
  catalogues: Catalogues,
  now: Date,
): Promise<ModelHealthReport> {
  const report: ModelHealthReport = { checked: [], problems: [], unavailable: [] };
  const enabled = models.filter((model) => model.enabled && catalogues[model.provider]);
  const providers = [...new Set(enabled.map((model) => model.provider))];
  const listed = new Map<Provider, ModelCatalogue>();
  await Promise.all(
    providers.map(async (provider) => {
      try {
        listed.set(provider, await (catalogues[provider] as () => Promise<ModelCatalogue>)());
      } catch (error) {
        report.unavailable.push(provider);
        log('WARN', 'Provider models list unavailable; its models are not checked', {
          provider,
          error,
        });
      }
    }),
  );

  const warnBefore = new Date(now.getTime() + EOL_WARNING_DAYS * DAY_MS).toISOString().slice(0, 10);
  for (const model of enabled) {
    const catalogue = listed.get(model.provider);
    if (!catalogue) continue;
    report.checked.push(model.id);
    const base = {
      modelId: model.id,
      provider: model.provider,
      providerModelId: model.providerModelId,
    };
    const entry = catalogue.get(model.providerModelId);
    if (!entry) {
      report.problems.push({ ...base, reason: 'missing' });
      continue;
    }
    const eolDate = [model.eolDate, entry.endOfLife]
      .filter((date): date is string => date !== undefined)
      .sort()[0];
    if (eolDate !== undefined && eolDate <= warnBefore) {
      report.problems.push({ ...base, reason: 'retiring', eolDate });
    } else if (entry.legacy) {
      report.problems.push({ ...base, reason: 'deprecated' });
    }
  }
  return report;
}

/**
 * Logs the report and publishes `ModelHealthProblems` (0 when all is well), which the model health alarm
 * watches. Each problem is an error line naming the model, for the alarm email's reader to find.
 */
export function reportModelHealth(report: ModelHealthReport, metrics: EmitMetrics): void {
  for (const problem of report.problems) {
    log('ERROR', 'Model health problem', { ...problem });
  }
  log('INFO', 'Model health checked', {
    checked: report.checked.length,
    problems: report.problems.length,
    unavailable: report.unavailable,
  });
  metrics([{ name: 'ModelHealthProblems', value: report.problems.length, unit: 'Count' }]);
}

/**
 * The models lists in a deployed worker: OpenAI with the key from `OPENAI_SECRET_ID`, Gemini on the configured
 * backend with `GEMINI_SECRET_ID`, and Bedrock with the function's role.
 */
export function deployedCatalogues(env: NodeJS.ProcessEnv = process.env): Catalogues {
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const openAiKey = secretApiKey(required('OPENAI_SECRET_ID'));
  const geminiCredential = secretString(required('GEMINI_SECRET_ID'));
  const geminiConfig = geminiConfigFromEnv(env);
  return {
    openai: async () => openAiModelCatalogue({ apiKey: await openAiKey() }),
    gemini: async () =>
      geminiModelCatalogue({ config: geminiConfig, credential: await geminiCredential() }),
    bedrock: () => bedrockModelCatalogue(),
  };
}

/** Runs daily from an EventBridge schedule over the environment's registry. */
export async function handler(): Promise<ModelHealthReport> {
  const table = tableContext();
  const registry = createRegistryLoader({
    source: dynamoRegistrySource(table.client, table.tableName),
    environment: workerEnvironment(),
  });
  const report = await checkModelHealth(await registry.models(), deployedCatalogues(), new Date());
  reportModelHealth(report, powertoolsMetrics());
  return report;
}
