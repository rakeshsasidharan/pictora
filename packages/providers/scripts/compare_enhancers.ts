import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { loadSeedRegistry, utcDate } from '@pictora/core';
import { writeFile } from 'node:fs/promises';
import { ENHANCER_CANDIDATES, createEnhancer, parseEnhancerModel } from '../src/enhancer.js';
import { secretApiKey } from '../src/secrets.js';
import { formatReport, runComparison } from './enhancer_comparison.js';
import { secretName } from './live_check.js';

/**
 * `npm run compare:enhancers [-- --models bedrock:<id>,gemini:<id>] [--out <file>]`
 *
 * The M2 enhancer model test (#20). Makes real, paid calls: Bedrock with the caller's AWS credentials, and
 * Gemini with the dev key in Secrets Manager. Writes a Markdown report (default `enhancer_comparison.md`).
 * Run by hand only; it refuses to run in CI.
 */
async function main(): Promise<number> {
  if (process.env.CI) {
    console.error('compare:enhancers makes paid provider calls and never runs in CI.');
    return 1;
  }
  const args = process.argv.slice(2);
  const option = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const names = (option('--models') ?? ENHANCER_CANDIDATES.join(','))
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const out = option('--out') ?? 'enhancer_comparison.md';

  const secrets = new SecretsManagerClient({ region: 'us-west-2' });
  const geminiApiKey = secretApiKey(secretName('dev', 'gemini'), { client: secrets });
  const candidates = names.map((name) => ({
    name,
    enhance: createEnhancer({ model: parseEnhancerModel(name), geminiApiKey }),
  }));

  console.log(`Comparing ${candidates.map((candidate) => candidate.name).join(' and ')}…`);
  const results = await runComparison(candidates, loadSeedRegistry());
  await writeFile(out, formatReport(results, utcDate(new Date())));
  for (const result of results) {
    console.log(
      `${result.candidate}: p50 ${result.p50Ms} ms, p95 ${result.p95Ms} ms, ${result.failures} failures`,
    );
  }
  console.log(`Report: ${out}`);
  return results.some((result) => result.failures === result.rewrites.length) ? 1 : 0;
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
