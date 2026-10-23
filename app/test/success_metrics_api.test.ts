import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  METRICS_COUNTS_SK,
  METRICS_SUMMARY_SK,
  PROFILE_SK,
  RATE_LIMIT_PER_MINUTE,
  dailySummary,
  imageSk,
  loadSeedRegistry,
  metricTargets,
  metricsPk,
  ttfiSk,
  userPk,
  versionSk,
} from '@pictora/core';
import { modelsAvailableIn } from '@pictora/core/registry-store';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { POST as ttfiRoute } from '../src/app/api/metrics/ttfi/route';
import { getAdminMetrics, type AdminMetricsBody } from '../src/lib/admin_metrics';
import type { AdminDeps } from '../src/lib/admin_stats';
import { deleteImage, versionDownloadUrl, type ImageDeleteDeps } from '../src/lib/images';
import { ensureProfile } from '../src/lib/profile';
import type { Session } from '../src/lib/session';
import { recordTtfi, type TtfiDeps } from '../src/lib/ttfi';
import { DYNAMODB_ENDPOINT, localTable } from './dynamodb_local';

const NOW = new Date('2026-10-15T12:00:00Z');
const admin: Session = { sub: 'admin-sub', email: 'admin@example.com', groups: ['admins'] };
const someone: Session = { sub: 'someone', email: 'someone@example.com', groups: [] };

const offline: AdminDeps = {
  client: { send: () => Promise.reject(new Error('no table')) } as unknown as AdminDeps['client'],
  tableName: 'unused',
  models: async () => modelsAvailableIn(loadSeedRegistry(), 'dev'),
  presign: async (key) => key,
  spendCapCents: 2000,
  defaultDailyPoints: 25,
  now: () => NOW,
  newId: () => '01JZZZZZZZZZZZZZZZZZZZZZZZ',
};

describe('POST /api/metrics/ttfi', () => {
  it('answers 401 without a session', async () => {
    const response = await ttfiRoute(
      new NextRequest('https://pictora.example.dev/api/metrics/ttfi', {
        method: 'POST',
        body: JSON.stringify({ ms: 1000 }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it('refuses a body that is not a whole number of milliseconds up to a day, before any table call', async () => {
    const deps: TtfiDeps = { client: offline.client, tableName: 'unused', now: () => NOW };
    for (const input of [{}, { ms: -5 }, { ms: 2.5 }, { ms: 86_400_001 }, { ms: 5, extra: 1 }]) {
      expect(await recordTtfi(deps, someone, input)).toMatchObject({
        status: 400,
        body: { code: 'invalid_request' },
      });
    }
  });
});

describe('GET /api/admin/metrics checks', () => {
  it('answers 403 to non-admins before reading anything, and checks the range', async () => {
    await expect(getAdminMetrics(offline, someone, {})).resolves.toMatchObject({ status: 403 });
    await expect(getAdminMetrics(offline, admin, { from: 'yesterday' })).resolves.toMatchObject({
      status: 400,
    });
    await expect(
      getAdminMetrics(offline, admin, { from: '2026-01-01', to: '2026-10-15' }),
    ).resolves.toMatchObject({ status: 400, body: { error: 'Pick a range of at most 92 days.' } });
  });
});

describe.skipIf(!DYNAMODB_ENDPOINT)('success metric events against DynamoDB Local', () => {
  const table = localTable('pictora-success-metrics');
  const { client, tableName } = table;
  const put = (item: Record<string, unknown>) =>
    client.send(new PutCommand({ TableName: tableName, Item: item }));
  const get = async (PK: string, SK: string) =>
    (await client.send(new GetCommand({ TableName: tableName, Key: { PK, SK } }))).Item;
  const counts = (date: string) => get(metricsPk(date), METRICS_COUNTS_SK);
  let users = 0;
  const newUser = (groups: string[] = []): Session => ({
    sub: `metrics-user-${++users}-${Date.now()}`,
    email: `user${users}@example.com`,
    groups,
  });

  beforeAll(() => table.create());
  afterAll(() => table.drop());

  describe('signup', () => {
    it('counts a new profile once, on the day it was made', async () => {
      const session = newUser();
      const day = '2026-09-01';
      const at = new Date(`${day}T10:00:00Z`);
      await ensureProfile(client, tableName, session, at);
      await ensureProfile(client, tableName, session, new Date(`${day}T10:05:00Z`));
      expect((await counts(day))?.signups).toBe(1);
      expect((await get(userPk(session.sub), PROFILE_SK))?.signupCountedAt).toBe(at.toISOString());
    });
  });

  describe('time to first image', () => {
    const deps: TtfiDeps = { client, tableName, now: () => NOW };

    it('stores a new account’s time once, on today’s partition, and counts it', async () => {
      const session = newUser();
      await ensureProfile(client, tableName, session, new Date('2026-10-15T11:58:00Z'));
      expect(await recordTtfi(deps, session, { ms: 42_000 })).toEqual({
        status: 200,
        body: { recorded: true },
      });
      expect(await recordTtfi(deps, session, { ms: 1_000 })).toEqual({
        status: 200,
        body: { recorded: false },
      });
      expect((await get(metricsPk('2026-10-15'), ttfiSk(session.sub)))?.ms).toBe(42_000);
      expect((await counts('2026-10-15'))?.firstImagesShown).toBe(1);
    });

    it('records nothing for an account over a day old, or one with no profile', async () => {
      const old = newUser();
      await ensureProfile(client, tableName, old, new Date('2026-10-13T12:00:00Z'));
      expect((await recordTtfi(deps, old, { ms: 5_000 })).body).toEqual({ recorded: false });
      expect((await recordTtfi(deps, newUser(), { ms: 5_000 })).body).toEqual({ recorded: false });
      expect(await get(metricsPk('2026-10-15'), ttfiSk(old.sub))).toBeUndefined();
    });

    it('counts in the rate window and answers 429 once it is full', async () => {
      const session = newUser();
      for (let call = 0; call < RATE_LIMIT_PER_MINUTE; call++) {
        expect((await recordTtfi(deps, session, { ms: 5_000 })).status).toBe(200);
      }
      expect(await recordTtfi(deps, session, { ms: 5_000 })).toMatchObject({
        status: 429,
        body: { code: 'rate_limited' },
      });
    });
  });

  describe('downloads and deletes', () => {
    const IMAGE_ID = '01JMETR1CSAAAAAAAAAAAAAAAA';
    const removePrefix = vi.fn<ImageDeleteDeps['removePrefix']>(async () => undefined);
    const deps: ImageDeleteDeps = {
      client,
      tableName,
      presign: async (key) => `https://signed.example/${key}`,
      removePrefix,
    };

    async function imageWith(session: Session, versions: Record<string, unknown>[]) {
      await put({ PK: userPk(session.sub), SK: imageSk(IMAGE_ID), imageId: IMAGE_ID });
      for (const [index, extra] of versions.entries()) {
        const version = index + 1;
        await put({
          PK: userPk(session.sub),
          SK: versionSk(IMAGE_ID, version),
          imageId: IMAGE_ID,
          version,
          s3Key: `users/${session.sub}/${IMAGE_ID}/v${version}.png`,
          thumbKey: `users/${session.sub}/${IMAGE_ID}/v${version}_thumb.webp`,
          ...extra,
        });
      }
    }

    it('counts the first download of a generated version only', async () => {
      const session = newUser();
      const today = new Date().toISOString().slice(0, 10);
      const before = (await counts(today))?.imagesDownloaded ?? 0;
      await imageWith(session, [{ source: 'upload' }, { jobId: 'job-2' }]);
      expect(await versionDownloadUrl(deps, session, IMAGE_ID, '2')).toMatch(/v2\.png$/);
      expect(await versionDownloadUrl(deps, session, IMAGE_ID, '2')).toMatch(/v2\.png$/);
      // An uploaded image isn't generated, so its download doesn't count.
      expect(await versionDownloadUrl(deps, session, IMAGE_ID, '1')).toMatch(/v1\.png$/);
      expect((await counts(today))?.imagesDownloaded).toBe(before + 1);
      expect((await get(userPk(session.sub), versionSk(IMAGE_ID, 2)))?.downloadedAt).toEqual(
        expect.any(String),
      );
    });

    it('counts recent generated versions deleted without a download as discarded', async () => {
      const session = newUser();
      const made = new Date(Date.now() - 2 * 86_400_000);
      const madeDay = made.toISOString().slice(0, 10);
      const before = (await counts(madeDay))?.imagesDiscarded ?? 0;
      await imageWith(session, [
        { jobId: 'job-1', createdAt: made.toISOString() },
        { jobId: 'job-2', createdAt: made.toISOString(), downloadedAt: made.toISOString() },
        { jobId: 'job-3', createdAt: made.toISOString() },
      ]);
      expect((await deleteImage(deps, session, IMAGE_ID)).status).toBe(200);
      expect((await counts(madeDay))?.imagesDiscarded).toBe(before + 2);
    });
  });

  describe('GET /api/admin/metrics', () => {
    const deps = (): AdminDeps => ({ ...offline, client, tableName });

    it('lists each day of the range, the period over the computed days, and the targets', async () => {
      const day = (date: string, signups: number, firstSessionGenerates: number) =>
        dailySummary(
          {
            date,
            counts: { signups, firstSessionGenerates, jobsSucceeded: 10, imagesGenerated: 10 },
            ttfiMs: [20_000, 40_000],
            weekSpendCents: 300,
            weekActiveUsers: 2,
            blocksReviewed: 0,
            falseBlocks: 0,
            windowClosed: date < '2026-10-07',
          },
          new Date(`${date}T00:30:00Z`),
        );
      for (const summary of [day('2026-10-05', 4, 3), day('2026-10-13', 6, 3)]) {
        await put({ PK: metricsPk(summary.date), SK: METRICS_SUMMARY_SK, ...summary });
      }

      const result = await getAdminMetrics(deps(), admin, { from: '2026-10-05', to: '2026-10-14' });
      expect(result.status).toBe(200);
      const body = result.body as unknown as AdminMetricsBody;
      expect(body.from).toBe('2026-10-05');
      expect(body.days).toHaveLength(10);
      expect(body.days[0]).toMatchObject({
        date: '2026-10-05',
        computed: true,
        activation: { value: 0.75 },
        keepRate: { value: 1 },
        timeToFirstImage: { value: 30_000, samples: 2 },
      });
      expect(body.days[1]).toMatchObject({ date: '2026-10-06', computed: false, activation: null });
      expect(body.days[8]?.keepRate).toBeNull();
      expect(body.period.activation).toEqual({ value: 0.6, numerator: 6, denominator: 10 });
      expect(body.period.keepRate).toEqual({ value: 1, numerator: 10, denominator: 10 });
      expect(body.period.timeToFirstImage).toEqual({ value: 30_000, samples: 4 });
      expect(body.period.costPerActiveUser).toEqual({ value: 150, days: 2 });
      expect(body.targets).toEqual(metricTargets(25));
      expect(body.computedAt).toBe('2026-10-13T00:30:00.000Z');
    });
  });
});
