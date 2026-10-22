import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  PLATFORM_PK,
  PROFILE_SK,
  TESTERS_GROUP,
  TOS_VERSION,
  loadSeedRegistry,
  signUpFlagPk,
  spendSk,
  userPk,
  type GenerateJobRequest,
} from '@pictora/core';
import { modelsAvailableIn } from '@pictora/core/registry-store';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJob, getMe, type JobsDeps } from '../src/lib/jobs';
import { readPremiumPause } from '../src/lib/platform_spend';
import { dailyLimit, ensureProfile } from '../src/lib/profile';
import type { Session } from '../src/lib/session';
import { DYNAMODB_ENDPOINT, localTable } from './dynamodb_local';

const devModels = modelsAvailableIn(loadSeedRegistry(), 'dev');
const NOW = new Date('2026-10-19T12:00:00.000Z');
const ONBOARDED = {
  tosAcceptedAt: '2026-10-14T09:00:00.000Z',
  tosVersion: TOS_VERSION,
  ageConfirmed: true,
};

function generate(quality: GenerateJobRequest['quality']): GenerateJobRequest {
  return {
    type: 'generate',
    prompt: 'A lighthouse at dusk',
    style: 'photorealistic',
    modelId: 'mock',
    aspect: '1:1',
    quality,
    count: 1,
  };
}

describe('dailyLimit', () => {
  it('gives a flagged account 5 points, unless dailyPoints is set', () => {
    expect(dailyLimit({}, 25)).toBe(25);
    expect(dailyLimit({ abuseFlag: 'disposable_email' }, 25)).toBe(5);
    expect(dailyLimit({ abuseFlag: 'many_accounts' }, 1000)).toBe(5);
    expect(dailyLimit({ abuseFlag: 'disposable_email', dailyPoints: 40 }, 25)).toBe(40);
    expect(dailyLimit({ abuseFlag: 'disposable_email', dailyPoints: 0 }, 25)).toBe(0);
    // Never more than the environment default.
    expect(dailyLimit({ abuseFlag: 'disposable_email' }, 3)).toBe(3);
  });
});

describe.skipIf(!DYNAMODB_ENDPOINT)('platform cap and abuse flags with DynamoDB Local', () => {
  const table = localTable('pictora-cap');
  const { client, tableName } = table;
  let sessions = 0;
  let ids = 0;
  let enqueue: ReturnType<typeof vi.fn<JobsDeps['enqueue']>>;

  const deps = (overrides: Partial<JobsDeps> = {}): JobsDeps => ({
    client,
    tableName,
    models: async () => devModels,
    hasQueue: () => true,
    enqueue,
    presign: async (key) => `https://signed.example/${key}`,
    objectSize: async () => undefined,
    defaultDailyPoints: 25,
    spendCapCents: 2000,
    now: () => NOW,
    newJobId: () => `01J${String(++ids).padStart(23, '0')}`,
    ...overrides,
  });
  const newSession = (email = 'user@example.com'): Session => {
    sessions += 1;
    // A tester, since these jobs use the Mock model.
    return { sub: `cap-${sessions}-${Date.now()}`, email, groups: [TESTERS_GROUP] };
  };
  const onboard = (sub: string) =>
    client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: userPk(sub), SK: PROFILE_SK },
        UpdateExpression: 'SET tosAcceptedAt = :at, tosVersion = :v, ageConfirmed = :yes',
        ExpressionAttributeValues: {
          ':at': ONBOARDED.tosAcceptedAt,
          ':v': ONBOARDED.tosVersion,
          ':yes': true,
        },
      }),
    );
  const setSpend = (spentCents: number | undefined) =>
    spentCents === undefined
      ? client.send(
          new DeleteCommand({
            TableName: tableName,
            Key: { PK: PLATFORM_PK, SK: spendSk('2026-10') },
          }),
        )
      : client.send(
          new PutCommand({
            TableName: tableName,
            Item: { PK: PLATFORM_PK, SK: spendSk('2026-10'), spentCents },
          }),
        );
  const freeSlots = (sub: string) =>
    client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: userPk(sub), SK: PROFILE_SK },
        UpdateExpression: 'SET activeJobs = :zero',
        ExpressionAttributeValues: { ':zero': 0 },
      }),
    );
  const markSignUp = (email: string, abuseFlag: string) =>
    client.send(
      new PutCommand({
        TableName: tableName,
        Item: { PK: signUpFlagPk(email), SK: 'ABUSE', abuseFlag, createdAt: NOW.toISOString() },
      }),
    );

  beforeAll(() => table.create());
  afterAll(() => table.drop());
  beforeEach(async () => {
    enqueue = vi.fn<JobsDeps['enqueue']>(async () => undefined);
    await setSpend(undefined);
  });

  describe('platform cap', () => {
    it('reads the pause below, at and above the cap', async () => {
      expect(await readPremiumPause(client, tableName, 2000, NOW)).toBeUndefined();
      await setSpend(1999);
      expect(await readPremiumPause(client, tableName, 2000, NOW)).toBeUndefined();
      await setSpend(2000);
      expect(await readPremiumPause(client, tableName, 2000, NOW)).toEqual({
        until: new Date('2026-11-01T00:00:00.000Z'),
      });
      await setSpend(2600);
      expect(await readPremiumPause(client, tableName, 2000, NOW)).toBeDefined();
      // Last month's spend doesn't count.
      expect(
        await readPremiumPause(client, tableName, 2000, new Date('2026-11-02T00:00:00Z')),
      ).toBeUndefined();
    });

    it('allows every quality below the cap', async () => {
      await setSpend(1999);
      const session = newSession();
      await onboard(session.sub);
      for (const quality of ['draft', 'standard', 'high'] as const) {
        expect((await createJob(deps(), session, generate(quality))).status).toBe(202);
        await freeSlots(session.sub);
      }
    });

    it('at or above the cap, refuses standard and high with the date, and keeps draft working', async () => {
      for (const spent of [2000, 2500]) {
        await setSpend(spent);
        const session = newSession();
        await onboard(session.sub);
        for (const quality of ['standard', 'high'] as const) {
          const result = await createJob(deps(), session, generate(quality));
          expect(result).toMatchObject({ status: 403, body: { code: 'premium_paused' } });
          expect(result.body.error).toBe(
            "Premium models are paused until 1 November because this month's budget is used up. Draft quality still works.",
          );
        }
        expect((await createJob(deps(), session, generate('draft'))).status).toBe(202);
        expect(enqueue).toHaveBeenCalledTimes(1);
        enqueue.mockClear();
      }
    });

    it('follows the configured cap', async () => {
      await setSpend(500);
      const session = newSession();
      await onboard(session.sub);
      const low = deps({ spendCapCents: 500 });
      expect((await createJob(low, session, generate('standard'))).status).toBe(403);
      expect((await createJob(deps(), session, generate('standard'))).status).toBe(202);
    });
  });

  describe('abuse flags', () => {
    it('copies a disposable-email flag onto the new profile, which then gets 5 points a day', async () => {
      const session = newSession('Someone@Mailinator.com');
      await markSignUp('someone@mailinator.com', 'disposable_email');

      const profile = await ensureProfile(client, tableName, session, NOW);

      expect(profile.abuseFlag).toBe('disposable_email');
      const stored = await client.send(
        new GetCommand({ TableName: tableName, Key: { PK: userPk(session.sub), SK: PROFILE_SK } }),
      );
      expect(stored.Item?.abuseFlag).toBe('disposable_email');
      const marker = await client.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: signUpFlagPk(session.email), SK: 'ABUSE' },
        }),
      );
      expect(marker.Item).toBeUndefined();
      expect((await getMe(deps(), session)).body).toMatchObject({ dailyLimit: 5, pointsLeft: 5 });
    });

    it('holds a flagged account to 5 points when creating jobs', async () => {
      const session = newSession('many@example.com');
      await markSignUp('many@example.com', 'many_accounts');
      await ensureProfile(client, tableName, session, NOW);
      await onboard(session.sub);

      // The mock model's high quality costs 3 points; two of them need 6.
      expect((await createJob(deps(), session, generate('high'))).status).toBe(202);
      await freeSlots(session.sub);
      expect(await createJob(deps(), session, generate('high'))).toMatchObject({
        status: 402,
        body: { code: 'out_of_points' },
      });
    });

    it('lets dailyPoints win over the flag', async () => {
      const session = newSession('flagged@mailinator.com');
      await markSignUp(session.email, 'disposable_email');
      await ensureProfile(client, tableName, session, NOW);
      await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { PK: userPk(session.sub), SK: PROFILE_SK },
          UpdateExpression: 'SET dailyPoints = :p',
          ExpressionAttributeValues: { ':p': 40 },
        }),
      );
      expect((await getMe(deps(), session)).body).toMatchObject({ dailyLimit: 40 });
    });

    it('leaves existing profiles and unflagged sign-ups alone', async () => {
      const clean = newSession('clean@example.com');
      expect((await ensureProfile(client, tableName, clean, NOW)).abuseFlag).toBeUndefined();
      expect((await getMe(deps(), clean)).body).toMatchObject({ dailyLimit: 25 });

      // A marker written after the profile exists isn't applied: flags are set at creation.
      const existing = newSession('later@example.com');
      await ensureProfile(client, tableName, existing, NOW);
      await markSignUp('later@example.com', 'disposable_email');
      const later = new Date(NOW.getTime() + 60_000);
      expect((await ensureProfile(client, tableName, existing, later)).abuseFlag).toBeUndefined();
    });
  });
});
