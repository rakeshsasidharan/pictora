import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { loadSeedRegistry } from '@pictora/core';
import { writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { SAMPLE_IMAGES } from '../../../app/src/lib/sample_images.js';
import { BEDROCK_REGION, BedrockProvider } from '../src/bedrock.js';
import { guardProvider } from '../src/factory.js';
import { OpenAiProvider } from '../src/openai.js';
import { providerSignal } from '../src/retry.js';
import { secretApiKey } from '../src/secrets.js';
import type { ImageProvider } from '../src/types.js';
import { GeminiCheckProvider, secretName, type LiveProvider } from './live_check.js';
import { APP_PUBLIC_DIR, parseSampleArgs, planSamples, toSampleWebp } from './style_samples.js';

/**
 * `npm run generate:samples [-- --style <id>]`
 *
 * Makes real, paid calls with the dev keys in Secrets Manager, using the caller's AWS credentials, and
 * overwrites the sample files in `app/public/static/samples/`. Review the images before committing them.
 */
async function main(): Promise<number> {
  if (process.env.CI) {
    console.error('generate:samples makes paid provider calls and never runs in CI.');
    return 1;
  }
  const plans = planSamples(
    SAMPLE_IMAGES,
    loadSeedRegistry(),
    parseSampleArgs(process.argv.slice(2)),
  );

  const secrets = new SecretsManagerClient({ region: BEDROCK_REGION });
  const adapters: Partial<Record<LiveProvider, ImageProvider>> = {};
  for (const provider of new Set(plans.map((plan) => plan.model.provider))) {
    if (provider === 'openai' || provider === 'gemini') {
      const apiKey = await secretApiKey(secretName('dev', provider), { client: secrets })();
      adapters[provider] =
        provider === 'openai'
          ? new OpenAiProvider({ apiKey: () => Promise.resolve(apiKey) })
          : new GeminiCheckProvider(apiKey);
    } else if (provider === 'bedrock') {
      adapters.bedrock = new BedrockProvider();
    }
  }

  let failed = 0;
  for (const plan of plans) {
    const label = `${plan.style} (${plan.model.id}, ${plan.quality})`;
    const adapter = adapters[plan.model.provider as LiveProvider];
    try {
      if (!adapter) throw new Error(`No adapter for ${plan.model.provider}`);
      const result = await guardProvider(adapter).generate(plan.model, {
        prompt: plan.prompt,
        aspect: '1:1',
        quality: plan.quality,
        count: 1,
        signal: providerSignal(),
      });
      const [image] = result.images;
      if (!image) throw new Error('No image returned');
      const { webp, quality } = await toSampleWebp(image.png);
      await writeFile(plan.file, webp);
      console.log(
        `OK    ${label}: ${relative(APP_PUBLIC_DIR, plan.file)}, ${(webp.length / 1024).toFixed(1)} KB at WebP quality ${quality}`,
      );
    } catch (error) {
      failed++;
      console.error(`FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failed > 0) console.error(`${failed} of ${plans.length} samples failed.`);
  return failed > 0 ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
