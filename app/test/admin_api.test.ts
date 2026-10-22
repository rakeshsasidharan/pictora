import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  PLATFORM_PK,
  PROFILE_SK,
  STATS_MODERATION_SK,
  TESTERS_GROUP,
  TOS_VERSION,
  imageKey,
  loadSeedRegistry,
  modlogPk,
  spendSk,
  statsEnhancerSk,
  statsModelSk,
  statsPk,
  thumbnailKey,
  usageRankSk,
  usageSk,
  userPk,
} from '@pictora/core';
import { modelsAvailableIn } from '@pictora/core/registry-store';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { listModeration, reviewCounters, reviewEntry } from '../src/lib/admin_moderation';
import { getAdminStats, type AdminDeps, type AdminStatsBody } from '../src/lib/admin_stats';
import { getAdminUser, setSuspension } from '../src/lib/admin_users';
import { createJob, type JobsDeps } from '../src/lib/jobs';
import type { Session } from '../src/lib/session';
import { DYNAMODB_ENDPOINT, localTable } from './dynamodb_local';

const devModels = modelsAvailableIn(loadSeedRegistry(), 'dev');
const NOW = new Date('2026-10-15T12:00:00Z');
const admin: Session = { sub: 'admin-sub', email: 'admin@example.com', groups: ['admins'] };
const someone: Session = { sub: 'someone', email: 'someone@example.com', groups: [] };

/** Deps that fail on any table call, for checks that answer first. */
const offline: AdminDeps = {
  client: { send: () => Promise.reject(new Error('no table')) } as unknown as AdminDeps['client'],
  tableName: 'unused',
  models: async () => devModels,
  presign: async (key) => key,
  spendCapCents: 2000,
  defaultDailyPoints: 25,
  now: () => NOW,
  newId: () => '01JZZZZZZZZZZZZZZZZZZZZZZZ',
};

describe('admin APIs refuse non-admins', () => {
  it('answers 403 before reading anything', async () => {
    const forbidden = { status: 403, body: { code: 'forbidden' } };
    await expect(getAdminStats(offline, someone, {})).resolves.toMatchObject(forbidden);
    await expect(listModeration(offline, someone, {})).resolves.toMatchObject(forbidden);
    await expect(
      reviewEntry(offline, someone, '2026-10-15', '01JAAAAAAAAAAAAAAAAAAAAAAA', { verdict: 'ok' }),
    ).resolves.toMatchObject(forbidden);
    await expect(getAdminUser(offline, someone, 'x')).resolves.toMatchObject(forbidden);
    await expect(setSuspension(offline, someone, 'x', 'suspend')).resolves.toMatchObject(forbidden);
  });

  it('checks the range and the inputs', async () => {
    await expect(getAdminStats(offline, admin, { from: 'yesterday' })).resolves.toMatchObject({
      status: 400,
    });
    await expect(
      getAdminStats(offline, admin, { from: '2026-10-15', to: '2026-10-01' }),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      getAdminStats(offline, admin, { from: '2026-01-01', to: '2026-10-15' }),
    ).resolves.toMatchObject({ status: 400, body: { error: /at most 92 days/ } });
    await expect(setSuspension(offline, admin, 'admin-sub', 'suspend')).resolves.toMatchObject({
      status: 400,
    });
    await expect(setSuspension(offline, admin, 'a#b', 'suspend')).resolves.toMatchObject({
      status: 404,
    });
  });
});

describe('reviewCounters', () => {
  it('counts a first review, a false block, and a changed verdict', () => {
    expect(reviewCounters('block', undefined, 'ok')).toEqual({ blocksReviewed: 1, falseBlocks: 1 });
    expect(reviewCounters('block', undefined, 'confirmed')).toEqual({ blocksReviewed: 1 });
    expect(reviewCounters('block', 'ok', 'confirmed')).toEqual({ falseBlocks: -1 });
    expect(reviewCounters('block', 'confirmed', 'ok')).toEqual({ falseBlocks: 1 });
    expect(reviewCounters('report', undefined, 'ok')).toEqual({ reportsReviewed: 1 });
    expect(reviewCounters('report', 'ok', 'confirmed')).toEqual({});
  });
});

describe.skipIf(!DYNAMODB_ENDPOINT)('admin APIs against DynamoDB Local', () => {
  const table = localTable('pictora-admin');
  const { client, tableName } = table;
  let ids = 0;
  const deps: AdminDeps = {
    ...offline,
    client,
    tableName,
    presign: async (key) => `https://signed.example/${key}`,
    newId: () => `01JX${String(++ids).padStart(22, '0')}`,
  };
  const put = (item: Record<string, unknown>) =>
    client.send(new PutCommand({ TableName: tableName, Item: item }));
  const get = async (PK: string, SK: string) =>
    (await client.send(new GetCommand({ TableName: tableName, Key: { PK, SK } }))).Item;
  const profile = (sub: string, fields: Record<string, unknown> = {}) =>
    put({
      PK: userPk(sub),
      SK: PROFILE_SK,
      email: `${sub}@example.com`,
      createdAt: '2026-10-01T00:00:00.000Z',
      status: 'active',
      activeJobs: 0,
      tosAcceptedAt: '2026-10-01T00:00:00.000Z',
      tosVersion: TOS_VERSION,
      ageConfirmed: true,
      ...fields,
    });
  const usage = (sub: string, used: number) =>
    put({
      PK: userPk(sub),
      SK: usageSk('2026-10-15'),
      used,
      GSI1PK: 'USAGE#2026-10-15',
      GSI1SK: usageRankSk(used),
    });
  const adminLog = async () =>
    (
      await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'PK = :pk',
          FilterExpression: '#type = :admin',
          ExpressionAttributeNames: { '#type': 'type' },
          ExpressionAttributeValues: { ':pk': modlogPk('2026-10-15'), ':admin': 'admin_action' },
        }),
      )
    ).Items ?? [];

  beforeAll(async () => {
    await table.create();
    // Two days of stats: OpenAI and Gemini on the 14th, Gemini and the enhancer on the 15th.
    await put({
      PK: statsPk('2026-10-14'),
      SK: statsModelSk('gpt-image-2'),
      images: 3,
      points: 18,
      providerCostCents: 17,
      failures: 1,
    });
    await put({
      PK: statsPk('2026-10-14'),
      SK: statsModelSk('gemini-3.1-flash-image'),
      images: 2,
      points: 14,
      providerCostCents: 13,
      blocks: 1,
    });
    await put({
      PK: statsPk('2026-10-15'),
      SK: statsModelSk('gemini-3.1-flash-image'),
      images: 4,
      points: 28,
      providerCostCents: 26,
      failures: 1,
      blocks: 2,
    });
    await put({
      PK: statsPk('2026-10-15'),
      SK: statsModelSk('stable-image-core'),
      images: 1,
      points: 4,
      providerCostCents: 4,
    });
    await put({
      PK: statsPk('2026-10-15'),
      SK: statsEnhancerSk('mock'),
      calls: 5,
      costCents: 2,
    });
    // Outside the range.
    await put({
      PK: statsPk('2026-09-01'),
      SK: statsModelSk('gpt-image-2'),
      images: 50,
      providerCostCents: 500,
    });
    await put({ PK: PLATFORM_PK, SK: spendSk('2026-10'), spentCents: 1234 });

    for (const [sub, used] of [
      ['heavy', 24],
      ['light', 3],
      ['middle', 12],
    ] as const) {
      await profile(sub);
      await usage(sub, used);
    }

    // Today's moderation log: two blocks, a report and an admin action.
    await put({
      PK: modlogPk('2026-10-15'),
      SK: '01JAAAAAAAAAAAAAAAAAAAAAA1',
      type: 'block',
      userId: 'heavy',
      stage: 'prompt',
      category: 'violence/graphic',
      promptExcerpt: 'A battle',
      provider: 'gemini',
      modelId: 'gemini-3.1-flash-image',
      jobId: 'JOB1',
      createdAt: '2026-10-15T09:00:00.000Z',
    });
    await put({
      PK: modlogPk('2026-10-15'),
      SK: '01JAAAAAAAAAAAAAAAAAAAAAA2',
      type: 'block',
      userId: 'light',
      stage: 'image',
      category: 'sexual',
      promptExcerpt: '',
      uploadId: 'UPLOAD1',
      createdAt: '2026-10-15T10:00:00.000Z',
    });
    await put({
      PK: modlogPk('2026-10-15'),
      SK: '01JAAAAAAAAAAAAAAAAAAAAAA3',
      type: 'report',
      userId: 'middle',
      reason: 'other',
      imageId: '01JIMAGEAAAAAAAAAAAAAAAAAA',
      version: 2,
      s3Key: imageKey('middle', '01JIMAGEAAAAAAAAAAAAAAAAAA', 2),
      promptExcerpt: 'A cat',
      createdAt: '2026-10-15T11:00:00.000Z',
    });
    await put({
      PK: modlogPk('2026-10-15'),
      SK: '01JAAAAAAAAAAAAAAAAAAAAAA0',
      type: 'admin_action',
      action: 'suspend',
      userId: 'admin-sub',
      targetUserId: 'x',
      createdAt: '2026-10-15T08:00:00.000Z',
    });
  });
  afterAll(() => table.drop());

  it('aggregates spend by day, model and provider over the range', async () => {
    const result = await getAdminStats(deps, admin, { from: '2026-10-14', to: '2026-10-15' });
    expect(result.status).toBe(200);
    const body = result.body as unknown as AdminStatsBody;
    expect(body.providers).toEqual(['openai', 'gemini', 'bedrock']);
    expect(body.days).toEqual([
      {
        date: '2026-10-14',
        spendCents: { openai: 17, gemini: 13 },
        enhancerCostCents: 0,
        images: 5,
        failures: 1,
        blocks: 1,
      },
      {
        date: '2026-10-15',
        spendCents: { gemini: 26, bedrock: 4 },
        enhancerCostCents: 2,
        images: 5,
        failures: 1,
        blocks: 2,
      },
    ]);
    expect(body.models).toEqual([
      {
        modelId: 'gemini-3.1-flash-image',
        displayName: 'Gemini 3.1 Flash Image',
        provider: 'gemini',
        images: 6,
        points: 42,
        providerCostCents: 39,
        failures: 1,
        blocks: 3,
      },
      expect.objectContaining({
        modelId: 'gpt-image-2',
        provider: 'openai',
        providerCostCents: 17,
      }),
      expect.objectContaining({ modelId: 'stable-image-core', provider: 'bedrock', images: 1 }),
    ]);
    expect(body.totals).toEqual({
      spendCents: 60,
      enhancerCostCents: 2,
      images: 10,
      points: 64,
      failures: 2,
      blocks: 3,
    });
    expect(body.month).toEqual({ month: '2026-10', spentCents: 1234, capCents: 2000 });
  });

  it("reports today's KPIs, with blocks from the moderation log", async () => {
    const body = (await getAdminStats(deps, admin, { from: '2026-10-01', to: '2026-10-02' }))
      .body as unknown as AdminStatsBody;
    expect(body.days.every((day) => day.images === 0)).toBe(true);
    expect(body.today).toEqual({
      date: '2026-10-15',
      spendCents: 32,
      images: 5,
      failures: 1,
      blocks: 2,
      failureRate: 1 / 6,
    });
  });

  it('defaults to the 14 days ending today', async () => {
    const body = (await getAdminStats(deps, admin, {})).body as unknown as AdminStatsBody;
    expect(body.from).toBe('2026-10-02');
    expect(body.to).toBe('2026-10-15');
    expect(body.days).toHaveLength(14);
  });

  it('lists the top users by points today, most first, with their email and status', async () => {
    const body = (await getAdminStats(deps, admin, {})).body as unknown as AdminStatsBody;
    expect(body.topUsers).toEqual([
      { sub: 'heavy', email: 'heavy@example.com', status: 'active', pointsUsed: 24 },
      { sub: 'middle', email: 'middle@example.com', status: 'active', pointsUsed: 12 },
      { sub: 'light', email: 'light@example.com', status: 'active', pointsUsed: 3 },
    ]);
  });

  it("lists the day's blocks and reports newest first, with report thumbnails", async () => {
    const result = await listModeration(deps, admin, { date: '2026-10-15' });
    expect(result.status).toBe(200);
    const { entries } = result.body as { entries: Record<string, unknown>[] };
    expect(entries.map((entry) => entry.id)).toEqual([
      '01JAAAAAAAAAAAAAAAAAAAAAA3',
      '01JAAAAAAAAAAAAAAAAAAAAAA2',
      '01JAAAAAAAAAAAAAAAAAAAAAA1',
    ]);
    expect(entries[0]).toMatchObject({
      type: 'report',
      reason: 'other',
      version: 2,
      thumbUrl: `https://signed.example/${thumbnailKey('middle', '01JIMAGEAAAAAAAAAAAAAAAAAA', 2)}`,
    });
    expect(entries[1]).toMatchObject({ type: 'block', stage: 'image', uploadId: 'UPLOAD1' });
    expect(entries[2]).not.toHaveProperty('thumbUrl');
    expect(await listModeration(deps, admin, { date: '2026-10-01' })).toMatchObject({
      body: { entries: [] },
    });
  });

  it('records verdicts, counts false blocks, moves the counts on a change, and logs each', async () => {
    const block = '01JAAAAAAAAAAAAAAAAAAAAAA1';
    const counts = async () => get(statsPk('2026-10-15'), STATS_MODERATION_SK);

    expect(await reviewEntry(deps, admin, '2026-10-15', block, { verdict: 'ok' })).toMatchObject({
      status: 200,
      body: { review: 'ok' },
    });
    expect(await get(modlogPk('2026-10-15'), block)).toMatchObject({
      review: 'ok',
      reviewedBy: 'admin-sub',
      reviewedAt: NOW.toISOString(),
    });
    expect(await counts()).toMatchObject({ blocksReviewed: 1, falseBlocks: 1 });

    await reviewEntry(deps, admin, '2026-10-15', block, { verdict: 'confirmed' });
    expect(await counts()).toMatchObject({ blocksReviewed: 1, falseBlocks: 0 });
    // The same verdict again changes nothing.
    await reviewEntry(deps, admin, '2026-10-15', block, { verdict: 'confirmed' });
    await reviewEntry(deps, admin, '2026-10-15', '01JAAAAAAAAAAAAAAAAAAAAAA3', {
      verdict: 'confirmed',
    });
    expect(await counts()).toMatchObject({ blocksReviewed: 1, falseBlocks: 0, reportsReviewed: 1 });

    const reviews = (await adminLog()).filter((entry) => entry.action === 'review');
    expect(reviews).toHaveLength(3);
    expect(reviews[0]).toMatchObject({
      userId: 'admin-sub',
      targetUserId: 'heavy',
      entryDate: '2026-10-15',
      entryId: block,
      verdict: 'ok',
    });

    const stats = (await getAdminStats(deps, admin, {})).body as unknown as AdminStatsBody;
    expect(stats.moderation).toEqual({ blocksReviewed: 1, falseBlocks: 0, reportsReviewed: 1 });
  });

  it('answers 404 for a missing entry or an admin action, and 400 for a bad verdict', async () => {
    await expect(
      reviewEntry(deps, admin, '2026-10-15', '01JBBBBBBBBBBBBBBBBBBBBBBB', { verdict: 'ok' }),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      reviewEntry(deps, admin, '2026-10-15', '01JAAAAAAAAAAAAAAAAAAAAAA0', { verdict: 'ok' }),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      reviewEntry(deps, admin, '2026-10-15', '01JAAAAAAAAAAAAAAAAAAAAAA2', { verdict: 'maybe' }),
    ).resolves.toMatchObject({ status: 400 });
  });

  it('suspends a user, which stops their jobs until they are unsuspended', async () => {
    const sub = 'suspendee';
    await profile(sub);
    // A tester, since the jobs it tries use the Mock model.
    const session: Session = { sub, email: `${sub}@example.com`, groups: [TESTERS_GROUP] };
    const jobsDeps: JobsDeps = {
      client,
      tableName,
      models: async () => devModels,
      hasQueue: () => true,
      enqueue: vi.fn(async () => undefined),
      presign: async (key) => key,
      objectSize: async () => undefined,
      defaultDailyPoints: 25,
      spendCapCents: 2000,
      now: () => NOW,
      newJobId: () => `01JJ${String(++ids).padStart(22, '0')}`,
    };
    const job = {
      type: 'generate',
      prompt: 'A lighthouse',
      style: 'none',
      modelId: 'mock',
      aspect: '1:1',
      quality: 'draft',
      count: 1,
    };

    expect(await setSuspension(deps, admin, sub, 'suspend')).toMatchObject({
      status: 200,
      body: { sub, status: 'suspended' },
    });
    const refused = await createJob(jobsDeps, session, job);
    expect(refused).toMatchObject({ status: 403, body: { code: 'suspended' } });
    expect(refused.body.error).toMatch(/suspended.*contact@rpillai\.dev/);
    // Suspending again is safe.
    expect(await setSuspension(deps, admin, sub, 'suspend')).toMatchObject({ status: 200 });
    expect(await getAdminUser(deps, admin, sub)).toMatchObject({
      status: 200,
      body: { sub, status: 'suspended', email: `${sub}@example.com`, dailyLimit: 25 },
    });

    expect(await setSuspension(deps, admin, sub, 'unsuspend')).toMatchObject({
      body: { status: 'active' },
    });
    expect((await createJob(jobsDeps, session, job)).status).toBe(202);

    const actions = (await adminLog())
      .filter((entry) => entry.targetUserId === sub)
      .map((entry) => entry.action);
    expect(actions).toEqual(['suspend', 'unsuspend']);
  });

  it('refuses to change an account being deleted, and answers 404 for no profile', async () => {
    await profile('leaving', { status: 'deleting' });
    await expect(setSuspension(deps, admin, 'leaving', 'suspend')).resolves.toMatchObject({
      status: 409,
      body: { code: 'invalid_state' },
    });
    expect((await get(userPk('leaving'), PROFILE_SK))?.status).toBe('deleting');
    await expect(setSuspension(deps, admin, 'nobody', 'suspend')).resolves.toMatchObject({
      status: 404,
    });
    await expect(getAdminUser(deps, admin, 'nobody')).resolves.toMatchObject({ status: 404 });
  });
});
