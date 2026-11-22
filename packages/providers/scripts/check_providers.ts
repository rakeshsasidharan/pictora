import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { loadSeedRegistry } from '@pictora/core';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BEDROCK_REGION, BedrockProvider } from '../src/bedrock.js';
import { createEnhancer, enhancerModelName } from '../src/enhancer.js';
import { GeminiProvider, geminiConfigFromEnv } from '../src/gemini.js';
import { OpenAiProvider } from '../src/openai.js';
import type { ImageProvider } from '../src/types.js';
import {
  OpenAiModerationCheck,
  environmentEnhancer,
  formatResults,
  parseArgs,
  runChecks,
  secretName,
  selectModels,
  type CheckDeps,
  type LiveProvider,
} from './live_check.js';

/** The CDK context, for the environment's enhancer. */
const CDK_JSON_URL = new URL('../../../infra/cdk.json', import.meta.url);

/**
 * `npm run check:providers [-- --env dev|prod] [--provider openai,gemini,bedrock] [--out <dir>]
 * [--enhancer bedrock:<id>|gemini:<id>|none]`
 *
 * Makes real, paid calls with the keys in Secrets Manager, using the caller's AWS credentials. Run by hand
 * only; it refuses to run in CI. The environment's prompt enhancer (`enhancerModel` in `infra/cdk.json`) is
 * checked with one rewrite whatever `--provider` says, unless it is the mock or `--enhancer none` is given.
 */
async function main(): Promise<number> {
  if (process.env.CI) {
    console.error('check:providers makes paid provider calls and never runs in CI.');
    return 1;
  }
  const options = parseArgs(process.argv.slice(2));
  const models = selectModels(loadSeedRegistry(), options.env, options.providers);
  if (models.length === 0) {
    console.error(`No enabled ${options.providers.join(', ')} models in ${options.env}.`);
    return 1;
  }

  const secrets = new SecretsManagerClient({ region: BEDROCK_REGION });
  const readSecret = async (provider: 'openai' | 'gemini'): Promise<string> => {
    const name = secretName(options.env, provider);
    const { SecretString } = await secrets.send(new GetSecretValueCommand({ SecretId: name }));
    const value = SecretString?.trim();
    if (!value) throw new Error(`Secret ${name} is empty`);
    return value;
  };

  const used = new Set(models.map((model) => model.provider as LiveProvider));
  const adapters: Partial<Record<LiveProvider, ImageProvider>> = {};
  const deps: CheckDeps = { adapters };
  if (used.has('openai')) {
    const apiKey = await readSecret('openai');
    adapters.openai = new OpenAiProvider({ apiKey: () => Promise.resolve(apiKey) });
    const moderation = new OpenAiModerationCheck(apiKey);
    deps.moderate = (input, signal) => moderation.moderate(input, signal);
  }
  if (used.has('gemini')) {
    // GEMINI_BACKEND (and GEMINI_VERTEX_PROJECT and GEMINI_VERTEX_LOCATION) pick the backend, as in the worker.
    const credential = await readSecret('gemini');
    adapters.gemini = new GeminiProvider({
      config: geminiConfigFromEnv(),
      credential: () => Promise.resolve(credential),
    });
  }
  if (used.has('bedrock')) adapters.bedrock = new BedrockProvider();

  const enhancer =
    options.enhancer ??
    environmentEnhancer(JSON.parse(await readFile(CDK_JSON_URL, 'utf8')).context, options.env);
  if (enhancer === 'none' || enhancer.backend === 'mock') {
    console.log(`Not checking the enhancer (${enhancer === 'none' ? 'none' : 'mock'}).`);
  } else {
    deps.enhancer = {
      name: enhancerModelName(enhancer),
      enhance: createEnhancer({
        model: enhancer,
        // The app reads the same secret for a gemini: enhancer.
        geminiApiKey: () => readSecret('gemini'),
      }),
    };
  }

  console.log(
    `Checking ${models.length} ${options.env} models: ${models.map((model) => model.id).join(', ')}`,
  );
  if (deps.enhancer) console.log(`and the enhancer ${deps.enhancer.name}`);
  const results = await runChecks(models, deps);

  const outDir = options.outDir ?? (await mkdtemp(join(tmpdir(), 'pictora-check-')));
  await mkdir(outDir, { recursive: true });
  for (const result of results) {
    if (result.png) await writeFile(join(outDir, `${result.name}.png`), result.png);
  }

  console.log(`\n${formatResults(results)}\n\nImages: ${outDir}`);
  const failed = results.filter((result) => !result.ok).length;
  if (failed > 0) console.error(`${failed} of ${results.length} checks failed.`);
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
