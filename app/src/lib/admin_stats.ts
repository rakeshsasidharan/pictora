import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  DEFAULT_STATS_RANGE_DAYS,
  MAX_STATS_RANGE_DAYS,
  PLATFORM_PK,
  PROFILE_SK,
  STATS_MODERATION_SK,
  TOP_USERS_LIMIT,
  adminStatsQuerySchema,
  datesBetween,
  daysBefore,
  modlogPk,
  spendSk,
  statsPk,
  userPk,
  utcDate,
  utcMonth,
  type ModelConfig,
} from '@pictora/core';
import { adminRefusal } from './admin';
import { apiError, type ApiResult } from './jobs';
import type { ProfileStatus } from './profile';
import type { Session } from './session';

/** What the admin APIs need, so tests can swap the table, the registry, S3 and the clock. */
export interface AdminDeps {
  client: DynamoDBDocumentClient;
  tableName: string;
  /** The environment's registry, switched-off models included, to name models and their providers. */
  models: () => Promise<ModelConfig[]>;
  /** A presigned GET URL for an object in the images bucket. */
  presign: (key: string) => Promise<string>;
  /** The monthly cap on platform provider spend, in cents (tech design 4.1). */
  spendCapCents: number;
  defaultDailyPoints: number;
  now: () => Date;
  newId: () => string;
}

/** One day of the dashboard (ADM-3): provider spend by provider, enhancer overhead, and job counts. */
export interface StatsDay {
  date: string;
  /** Provider cost in cents, by provider (`openai`, `gemini`, `bedrock`, `mock`). */
  spendCents: Record<string, number>;
  enhancerCostCents: number;
  images: number;
  failures: number;
  blocks: number;
}

/** One model's totals over the range. */
export interface StatsModel {
  modelId: string;
  displayName: string;
  provider: string;
  images: number;
  points: number;
  providerCostCents: number;
  failures: number;
  blocks: number;
}

export interface TopUser {
  sub: string;
  email?: string;
  status?: ProfileStatus;
  pointsUsed: number;
}

/** The `GET /api/admin/stats` body. */
export interface AdminStatsBody {
  from: string;
  to: string;
  /** Providers with spend or jobs in the range, in a fixed order. */
  providers: string[];
  days: StatsDay[];
  models: StatsModel[];
  totals: {
    spendCents: number;
    enhancerCostCents: number;
    images: number;
    points: number;
    failures: number;
    blocks: number;
  };
  /** Today (UTC), whatever the range. */
  today: {
    date: string;
    /** Provider spend plus enhancer overhead. */
    spendCents: number;
    images: number;
    failures: number;
    /** Every block in today's moderation log: prompts, images, provider refusals and uploads. */
    blocks: number;
    /** Failed jobs ÷ (failed jobs + images made); 0 with nothing finished. */
    failureRate: number;
  };
  month: { month: string; spentCents: number; capCents: number };
  /** Reviews of blocks in the range (ADM-4), for the PRD's moderation false-block metric. */
  moderation: { blocksReviewed: number; falseBlocks: number; reportsReviewed: number };
  /** The top users by points used today, most first. */
  topUsers: TopUser[];
}

/** The order providers are listed in; others follow alphabetically. */
const PROVIDER_ORDER = ['openai', 'gemini', 'bedrock', 'mock'];

interface StatsItem {
  SK: string;
  images?: number;
  points?: number;
  providerCostCents?: number;
  failures?: number;
  blocks?: number;
  costCents?: number;
  blocksReviewed?: number;
  falseBlocks?: number;
  reportsReviewed?: number;
}

const count = (value: number | undefined) => (typeof value === 'number' ? value : 0);

/**
 * `GET /api/admin/stats?from=&to=` (ADM-3): spend by day, model and provider, images, failures and blocks per
 * model, from the `STATS#<date>` items; month-to-date spend against the cap from `PLATFORM`; and the top 20
 * users by points today, from GSI1 on `USAGE#<today>`. The range defaults to the 14 days ending today, and can
 * cover at most 92 days.
 */
export async function getAdminStats(
  deps: AdminDeps,
  session: Session,
  query: Record<string, string>,
): Promise<ApiResult> {
  const refusal = adminRefusal(session);
  if (refusal) return refusal;
  const parsed = adminStatsQuerySchema.safeParse(query);
  if (!parsed.success) {
    return apiError('invalid_request', 'Use dates like 2026-10-15 for from and to.');
  }
  const now = deps.now();
  const today = utcDate(now);
  const to = parsed.data.to ?? today;
  const from = parsed.data.from ?? daysBefore(to, DEFAULT_STATS_RANGE_DAYS - 1);
  const dates = datesBetween(from, to);
  if (dates.length === 0)
    return apiError('invalid_request', 'The start date is after the end date.');
  if (dates.length > MAX_STATS_RANGE_DAYS) {
    return apiError('invalid_request', `Pick a range of at most ${MAX_STATS_RANGE_DAYS} days.`);
  }

  const registry = new Map((await deps.models()).map((model) => [model.id, model]));
  const providerOf = (modelId: string) => registry.get(modelId)?.provider ?? 'unknown';
  const [rangeItems, todayItems, month, blocksToday, topUsers] = await Promise.all([
    Promise.all(dates.map((date) => readStatsDay(deps, date))),
    readStatsDay(deps, today),
    readMonthSpend(deps, utcMonth(now)),
    countBlocks(deps, today),
    readTopUsers(deps, today),
  ]);

  const providers = new Set<string>();
  const models = new Map<string, StatsModel>();
  const moderation = { blocksReviewed: 0, falseBlocks: 0, reportsReviewed: 0 };
  const days: StatsDay[] = dates.map((date, index) => {
    const day: StatsDay = {
      date,
      spendCents: {},
      enhancerCostCents: 0,
      images: 0,
      failures: 0,
      blocks: 0,
    };
    for (const item of rangeItems[index] ?? []) {
      if (item.SK.startsWith('MODEL#')) {
        const modelId = item.SK.slice('MODEL#'.length);
        const provider = providerOf(modelId);
        providers.add(provider);
        day.spendCents[provider] = (day.spendCents[provider] ?? 0) + count(item.providerCostCents);
        day.images += count(item.images);
        day.failures += count(item.failures);
        day.blocks += count(item.blocks);
        const total = models.get(modelId) ?? {
          modelId,
          displayName: registry.get(modelId)?.displayName ?? modelId,
          provider,
          images: 0,
          points: 0,
          providerCostCents: 0,
          failures: 0,
          blocks: 0,
        };
        total.images += count(item.images);
        total.points += count(item.points);
        total.providerCostCents += count(item.providerCostCents);
        total.failures += count(item.failures);
        total.blocks += count(item.blocks);
        models.set(modelId, total);
      } else if (item.SK.startsWith('ENHANCER#')) {
        day.enhancerCostCents += count(item.costCents);
      } else if (item.SK === STATS_MODERATION_SK) {
        moderation.blocksReviewed += count(item.blocksReviewed);
        moderation.falseBlocks += count(item.falseBlocks);
        moderation.reportsReviewed += count(item.reportsReviewed);
      }
    }
    return day;
  });

  const sum = (pick: (day: StatsDay) => number) =>
    days.reduce((total, day) => total + pick(day), 0);
  const daySpend = (day: StatsDay) =>
    Object.values(day.spendCents).reduce((total, cents) => total + cents, 0);
  const modelList = [...models.values()].sort(
    (a, b) => b.providerCostCents - a.providerCostCents || a.modelId.localeCompare(b.modelId),
  );

  const todayTotals = { spendCents: 0, images: 0, failures: 0 };
  for (const item of todayItems) {
    if (item.SK.startsWith('MODEL#')) {
      todayTotals.spendCents += count(item.providerCostCents);
      todayTotals.images += count(item.images);
      todayTotals.failures += count(item.failures);
    } else if (item.SK.startsWith('ENHANCER#')) {
      todayTotals.spendCents += count(item.costCents);
    }
  }
  const finished = todayTotals.failures + todayTotals.images;

  const body: AdminStatsBody = {
    from,
    to,
    providers: sortProviders(providers),
    days,
    models: modelList,
    totals: {
      spendCents: sum(daySpend),
      enhancerCostCents: sum((day) => day.enhancerCostCents),
      images: sum((day) => day.images),
      points: modelList.reduce((total, model) => total + model.points, 0),
      failures: sum((day) => day.failures),
      blocks: sum((day) => day.blocks),
    },
    today: {
      date: today,
      ...todayTotals,
      blocks: blocksToday,
      failureRate: finished > 0 ? todayTotals.failures / finished : 0,
    },
    month: { month: utcMonth(now), spentCents: month, capCents: deps.spendCapCents },
    moderation,
    topUsers,
  };
  return { status: 200, body: { ...body } };
}

function sortProviders(providers: Set<string>): string[] {
  return [...providers].sort((a, b) => {
    const rank = (provider: string) => {
      const index = PROVIDER_ORDER.indexOf(provider);
      return index === -1 ? PROVIDER_ORDER.length : index;
    };
    return rank(a) - rank(b) || a.localeCompare(b);
  });
}

/** Every item under `STATS#<date>`: one per model, one per enhancer model, and the moderation reviews. */
async function readStatsDay(deps: AdminDeps, date: string): Promise<StatsItem[]> {
  const items: StatsItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await deps.client.send(
      new QueryCommand({
        TableName: deps.tableName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': statsPk(date) },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...((page.Items ?? []) as StatsItem[]));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

async function readMonthSpend(deps: AdminDeps, month: string): Promise<number> {
  const result = await deps.client.send(
    new GetCommand({ TableName: deps.tableName, Key: { PK: PLATFORM_PK, SK: spendSk(month) } }),
  );
  return count(result.Item?.spentCents as number | undefined);
}

/** Blocks in the day's moderation log. */
async function countBlocks(deps: AdminDeps, date: string): Promise<number> {
  let total = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await deps.client.send(
      new QueryCommand({
        TableName: deps.tableName,
        KeyConditionExpression: 'PK = :pk',
        FilterExpression: '#type = :block',
        ExpressionAttributeNames: { '#type': 'type' },
        ExpressionAttributeValues: { ':pk': modlogPk(date), ':block': 'block' },
        Select: 'COUNT',
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    total += page.Count ?? 0;
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return total;
}

/**
 * The top users by points used on the day, from GSI1 (`GSI1PK = USAGE#<date>`, `GSI1SK` = points used,
 * zero-padded, written by the worker after each settle or refund), with each user's email and status.
 */
async function readTopUsers(deps: AdminDeps, date: string): Promise<TopUser[]> {
  const page = await deps.client.send(
    new QueryCommand({
      TableName: deps.tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :usage',
      ExpressionAttributeValues: { ':usage': `USAGE#${date}` },
      ScanIndexForward: false,
      Limit: TOP_USERS_LIMIT,
    }),
  );
  const usage = (page.Items ?? []).map((item) => ({
    sub: String(item.PK).slice('USER#'.length),
    pointsUsed: Math.max(0, count(item.used as number | undefined)),
  }));
  if (usage.length === 0) return [];
  const profiles = await deps.client.send(
    new BatchGetCommand({
      RequestItems: {
        [deps.tableName]: {
          Keys: usage.map(({ sub }) => ({ PK: userPk(sub), SK: PROFILE_SK })),
          ProjectionExpression: 'PK, email, #status',
          ExpressionAttributeNames: { '#status': 'status' },
        },
      },
    }),
  );
  const bySub = new Map(
    (profiles.Responses?.[deps.tableName] ?? []).map((item) => [
      String(item.PK).slice('USER#'.length),
      item as { email?: string; status?: ProfileStatus },
    ]),
  );
  return usage.map((user) => {
    const profile = bySub.get(user.sub);
    return {
      ...user,
      ...(profile?.email ? { email: profile.email } : {}),
      ...(profile?.status ? { status: profile.status } : {}),
    };
  });
}
