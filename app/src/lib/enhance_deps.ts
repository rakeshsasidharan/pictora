import {
  createEnhancer,
  createModerator,
  enhancerModelName,
  parseEnhancerModel,
  secretApiKey,
  type Enhance,
  type Moderate,
} from '@pictora/providers/text';
import { documentClient, tableName } from './dynamodb';
import type { EnhanceDeps } from './enhance';
import { registryLoader } from './registry';

let moderate: Moderate | undefined;
let enhance: Enhance | undefined;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * The enhancer API's dependencies in a deployed app: DynamoDB, the registry, moderation with the OpenAI key
 * from the secret named in `OPENAI_SECRET_ID`, and the enhancer from `ENHANCER_MODEL`. A `gemini:` enhancer
 * reads its key from the secret named in `GEMINI_SECRET_ID`; a `bedrock:` one uses the app's IAM role.
 */
export function enhanceDeps(): EnhanceDeps {
  const model = parseEnhancerModel(process.env.ENHANCER_MODEL);
  moderate ??= createModerator({ apiKey: secretApiKey(required('OPENAI_SECRET_ID')) });
  enhance ??= createEnhancer({
    model,
    ...(model.backend === 'gemini'
      ? { geminiApiKey: secretApiKey(required('GEMINI_SECRET_ID')) }
      : {}),
  });
  return {
    client: documentClient(),
    tableName: tableName(),
    models: () => registryLoader().models(),
    moderate,
    enhance,
    enhancerModel: enhancerModelName(model),
    now: () => new Date(),
  };
}
