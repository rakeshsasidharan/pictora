import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Node } from 'constructs';

export type EnvName = 'dev' | 'prod';

/** The Route 53 hosted zone that holds the site records and certificate validation (tech design 14). */
export const HOSTED_ZONE_NAME = 'rpillai.dev';

/** Used when no `hostedZoneId` context is given, so synth works without AWS access. Deploys pass the real ID. */
export const PLACEHOLDER_HOSTED_ZONE_ID = 'Z0000000000PLACEHOLDER';

/** Used when no `appImageDigest` context is given (tests, PR checks). Deploys pass the pushed image's digest. */
export const PLACEHOLDER_IMAGE_DIGEST = `sha256:${'0'.repeat(64)}`;

/** Where the app build leaves its static files, relative to this file. */
const DEFAULT_APP_STATIC_DIR = fileURLToPath(new URL('../../app/.next/static', import.meta.url));
const DEFAULT_APP_PUBLIC_DIR = fileURLToPath(new URL('../../app/public', import.meta.url));

const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

/** Per-environment settings from the `environments` context in `infra/cdk.json` (tech design 10 and 14). */
export interface EnvironmentSettings {
  /** Site domain under `rpillai.dev`. Without one, the site is served on the CloudFront domain. */
  readonly domain?: string;
  /** Points each user gets per UTC day, unless their profile overrides it. */
  readonly dailyPoints: number;
  /** Monthly platform cap on provider spend, in US dollars. */
  readonly spendCapUsd: number;
  /** Maximum concurrent worker invocations per provider queue. */
  readonly queueConcurrency: number;
  /** Monthly AWS Budgets amount for this environment's infrastructure, in US dollars. */
  readonly budgetUsd: number;
  /** Reserved concurrency for the app Lambda, as a cost guard. Unset means unreserved. */
  readonly appReservedConcurrency?: number;
}

/** Values passed with `-c` at deploy time, with placeholders so synth works without them. */
export interface DeploySettings {
  readonly hostedZoneId: string;
  readonly appImageDigest: string;
  /** True when no real image digest was given, so the stage can't be deployed as is. */
  readonly placeholderImage: boolean;
  readonly gitSha: string;
  /** Email for the alert topic. Kept out of the repo; without it the topic has no subscription. */
  readonly alertEmail?: string;
  /** Next.js `.next/static` output, served under `/_next/static/`. */
  readonly appStaticDir: string;
  /** Next.js `public` folder; files under `public/static/` are served from S3. */
  readonly appPublicDir: string;
}

export interface StageConfig extends EnvironmentSettings, DeploySettings {
  readonly envName: EnvName;
}

/** Reads and checks the settings for one environment from CDK context. Throws on missing or invalid values. */
export function stageConfig(node: Node, envName: EnvName): StageConfig {
  return { envName, ...environmentSettings(node, envName), ...deploySettings(node) };
}

function environmentSettings(node: Node, envName: EnvName): EnvironmentSettings {
  const environments: unknown = node.tryGetContext('environments');
  const raw = isRecord(environments) ? environments[envName] : undefined;
  if (!isRecord(raw)) {
    throw new Error(`CDK context environments.${envName} is missing from infra/cdk.json`);
  }
  const where = `environments.${envName}`;

  const domain = optionalString(raw, 'domain', where);
  if (domain !== undefined && !domain.endsWith(`.${HOSTED_ZONE_NAME}`)) {
    throw new Error(`${where}.domain must be a subdomain of ${HOSTED_ZONE_NAME}: ${domain}`);
  }

  return {
    domain,
    dailyPoints: positiveInteger(raw, 'dailyPoints', where),
    spendCapUsd: positiveInteger(raw, 'spendCapUsd', where),
    queueConcurrency: positiveInteger(raw, 'queueConcurrency', where),
    budgetUsd: positiveInteger(raw, 'budgetUsd', where),
    appReservedConcurrency:
      raw.appReservedConcurrency === undefined
        ? undefined
        : positiveInteger(raw, 'appReservedConcurrency', where),
  };
}

function deploySettings(node: Node): DeploySettings {
  const digest = contextString(node, 'appImageDigest');
  if (digest !== undefined && !IMAGE_DIGEST_PATTERN.test(digest)) {
    throw new Error(
      `CDK context appImageDigest must look like sha256:<64 hex characters>: ${digest}`,
    );
  }
  const appImageDigest = digest ?? PLACEHOLDER_IMAGE_DIGEST;
  const placeholderImage = appImageDigest === PLACEHOLDER_IMAGE_DIGEST;

  const appStaticDir = contextString(node, 'appStaticDir') ?? DEFAULT_APP_STATIC_DIR;
  if (!placeholderImage && !existsSync(appStaticDir)) {
    throw new Error(
      `App static files not found at ${appStaticDir}. Extract them from the app image (infra/README.md) and pass -c appStaticDir=<dir>.`,
    );
  }

  return {
    hostedZoneId: contextString(node, 'hostedZoneId') ?? PLACEHOLDER_HOSTED_ZONE_ID,
    appImageDigest,
    placeholderImage,
    gitSha: contextString(node, 'gitSha') ?? 'local',
    alertEmail: contextString(node, 'alertEmail'),
    appStaticDir,
    appPublicDir: contextString(node, 'appPublicDir') ?? DEFAULT_APP_PUBLIC_DIR,
  };
}

/** A context value given with `-c`, treating an empty string as unset. */
function contextString(node: Node, key: string): string | undefined {
  const value: unknown = node.tryGetContext(key);
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`CDK context ${key} must be a string`);
  return value;
}

function optionalString(raw: Record<string, unknown>, key: string, where: string) {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${where}.${key} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(raw: Record<string, unknown>, key: string, where: string): number {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${where}.${key} must be a positive integer`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
