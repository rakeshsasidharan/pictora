import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { App } from 'aws-cdk-lib';
import { createPictoraApp } from '../lib/pictora_app.js';
import type { PictoraStage } from '../lib/pictora_stage.js';

export const FIXTURE_STATIC_DIR = fileURLToPath(new URL('fixtures/app_static', import.meta.url));
export const FIXTURE_PUBLIC_DIR = fileURLToPath(new URL('fixtures/app_public', import.meta.url));
export const TEST_IMAGE_DIGEST = `sha256:${'a'.repeat(64)}`;

/** The context in infra/cdk.json, which the CDK CLI passes to the app but tests must load themselves. */
export function cdkJsonContext(): Record<string, unknown> {
  const cdkJson = JSON.parse(readFileSync(new URL('../cdk.json', import.meta.url), 'utf8'));
  return cdkJson.context;
}

/** The CDK app with the cdk.json context, fixture static files, and any extra `-c` style values. */
export function testApp(context: Record<string, unknown> = {}): App {
  return createPictoraApp({
    context: {
      ...cdkJsonContext(),
      appStaticDir: FIXTURE_STATIC_DIR,
      appPublicDir: FIXTURE_PUBLIC_DIR,
      ...context,
    },
  });
}

export function testStage(name: 'PictoraDev' | 'PictoraProd', context?: Record<string, unknown>) {
  return testApp(context).node.findChild(name) as PictoraStage;
}
