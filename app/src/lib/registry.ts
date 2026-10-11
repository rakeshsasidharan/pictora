import type { Environment } from '@pictora/core';
import {
  createRegistryLoader,
  dynamoRegistrySource,
  type RegistryLoader,
} from '@pictora/core/registry-store';
import { documentClient, tableName } from './dynamodb';

/**
 * The environment the app serves, from `PICTORA_ENV`. Local `next dev` defaults to dev; anything else defaults
 * to prod, so a misconfigured deploy never offers the dev-only mock model.
 */
export function appEnvironment(env: NodeJS.ProcessEnv = process.env): Environment {
  if (env.PICTORA_ENV === 'dev' || env.PICTORA_ENV === 'prod') return env.PICTORA_ENV;
  return env.NODE_ENV === 'development' ? 'dev' : 'prod';
}

let loader: RegistryLoader | undefined;

/** The app's registry loader: DynamoDB, cached in memory for 60 s (tech design 6.1). */
export function registryLoader(): RegistryLoader {
  loader ??= createRegistryLoader({
    source: dynamoRegistrySource(documentClient(), tableName()),
    environment: appEnvironment(),
  });
  return loader;
}
